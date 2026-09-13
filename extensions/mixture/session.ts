import { createHash, randomUUID } from "node:crypto";
import { StringEnum, isContextOverflow, type AssistantMessage, type Context, type ImageContent, type Message, type ModelThinkingLevel, type SimpleStreamOptions, type Tool, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { compactRole, estimateContextTokens, forModel, imageContent, interruptPending } from "./context.ts";
import type { BackgroundJobQuery } from "../bg-bash/events.ts";
import type { Preset } from "./config.ts";
import { addUsage, callRole, emptyUsage, failureMessage, resolveModel, type Registry } from "./provider.ts";
import { executionDelta, newReviewer, ReviewPool, type CheckpointReview, type ReviewerState } from "./review.ts";
import { drainReceipts, receipt, receiptIds, tagReceipts, type UsageReceipt } from "./usage.ts";

export const CONTROL = "mixture_control";
export const ControlParams = Type.Object({
	action: StringEnum(["delegate", "report", "takeover", "checkpoint", "pause"]),
	task: Type.Optional(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String())),
	successCriteria: Type.Optional(Type.Array(Type.String())),
	report: Type.Optional(Type.String()),
	checkpoint: Type.Optional(Type.String()),
});
export type ControlInput = Static<typeof ControlParams>;
export const controlTool: Tool = {
	name: CONTROL,
	description: "Mixture role coordination. Lead: delegate a bounded task with constraints and successCriteria, or explicitly take over writing after the writer stops. Writer: report results, changed files, verification and remaining issues to the lead. Never combine a control with other tool calls. Checkpoint is reserved for the harness.",
	parameters: ControlParams,
};
export type Actor = "lead" | "writer";
interface Origin { actor: Actor; synthetic: boolean }
export interface RoleState { messages: Message[]; usage: Usage; calls: number; summaries?: number; contextTokens?: number }
export interface TimingAggregate { count: number; totalMs: number; maxMs: number; lastMs: number }
export interface PerformanceStats {
	requests: Record<string, TimingAggregate>;
	checkpoints: Record<string, TimingAggregate>;
}
export interface MixtureState {
	version: 2;
	preset: string;
	configKey: string;
	id: string;
	active: Actor;
	owner?: Actor;
	lead: RoleState;
	writer: RoleState;
	reviewers: ReviewerState[];
	receipts: UsageReceipt[];
	reviewSummary?: string;
	seenUsers: string[];
	initialized: boolean;
	brief: string;
	task: string;
	attachments: ImageContent[];
	revision: number;
	delegations: number;
	writerTurns: number;
	finalCorrections: number;
	jobs: Record<string, Actor>;
	bgManaged: boolean;
	rootCompactionId?: string;
	final?: { message: AssistantMessage; checkpoint: string; receipt: string; ready: boolean };
	origins: Record<string, Origin>;
	warning?: string;
}
const freshRole = (): RoleState => ({ messages: [], usage: emptyUsage(), calls: 0 });
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function newState(name: string, preset: Preset): MixtureState {
	return { version: 2, preset: name, configKey: fingerprint(preset), id: randomUUID(), active: "lead",
		lead: freshRole(), writer: freshRole(), reviewers: preset.reviewers.map(newReviewer), receipts: [], seenUsers: [], initialized: false, brief: "", task: "", attachments: [], revision: 0,
		delegations: 0, writerTurns: 0, finalCorrections: 0, jobs: {}, bgManaged: false, origins: {} };
}
const text = (message: AssistantMessage) => message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_run", "get_goal", "ask_user"]);
const SPAWN_TOOLS = new Set(["subagent", "subagent_process", "swarm_spawn", "swarm_restart", "run_experiment"]);

export class MixtureSession {
	readonly state: MixtureState;
	private controller = new AbortController();
	private epoch = 0;
	private inFlightCost = 0;
	private requestOptions: SimpleStreamOptions = {};
	private leadThinking?: ModelThinkingLevel;
	lastDrained: string[] = [];
	private systemPrompt = "";
	private firstTaskSync = true;
	private autoDelegate = false;
	private rootTools: Tool[] = [];
	private readonly timings: PerformanceStats = { requests: {}, checkpoints: {} };
	readonly reviews: ReviewPool;
	constructor(readonly preset: Preset, readonly registry: Registry, state: MixtureState,
		private readonly jobs: () => BackgroundJobQuery,
		private readonly changed: () => void = () => {}, cwd = process.cwd()) {
		this.state = state;
		this.autoDelegate = state.active === "lead" && state.delegations === 0 && !state.brief && !!state.task.trim();
		this.reviews = new ReviewPool(preset, state.reviewers, cwd, async (index, context, signal) => {
			const result = await this.call(index, context, { ...this.requestOptions,
				signal: AbortSignal.any([signal, ...(this.requestOptions.signal ? [this.requestOptions.signal] : [])]) });
			return result.message;
		}, id => resolveModel(id, registry.find.bind(registry)).input.includes("image"), changed);
	}

	get signal() { return this.controller.signal; }
	get active() { return this.state.active; }
	get modelId() { return this.active === "lead" ? this.preset.lead : this.preset.writer.model; }
	performanceStats(): PerformanceStats { return structuredClone(this.timings); }
	private recordTiming(group: keyof PerformanceStats, name: string, started: number) {
		const elapsed = Math.max(0, performance.now() - started);
		const current = this.timings[group][name] ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
		current.count++;
		current.totalMs += elapsed;
		current.maxMs = Math.max(current.maxMs, elapsed);
		current.lastMs = elapsed;
		this.timings[group][name] = current;
	}
	private async reviewCheckpoint(kind: "writer-report" | "final-answer", revision: number, content: string, signal?: AbortSignal, images?: ImageContent[], candidateOnly = false) {
		const started = performance.now();
		try { return await this.reviews.checkpoint(revision, content, signal, images, candidateOnly); }
		finally { this.recordTiming("checkpoints", kind, started); }
	}
	get usage() {
		const total = emptyUsage();
		for (const role of [this.state.lead, this.state.writer, ...this.state.reviewers]) addUsage(total, role.usage);
		return total;
	}
	rootContextTokens() {
		return Math.max(1, estimateContextTokens({ systemPrompt: this.prompt("lead"), messages: this.state.lead.messages, tools: this.tools("lead") }).tokens);
	}

	rebaseLeadAfterCompaction(compactionId: string) {
		this.state.rootCompactionId = compactionId;
		this.state.lead.messages = [];
		this.state.lead.contextTokens = undefined;
		this.state.seenUsers = [];
		this.state.initialized = false;
		this.firstTaskSync = true;
	}

	newRequest(task = "") {
		this.controller.abort();
		this.controller = new AbortController();
		this.epoch++;
		this.state.delegations = 0;
		this.state.writerTurns = 0;
		this.state.finalCorrections = 0;
		this.state.warning = undefined;
		this.state.task = task;
		this.state.attachments = [];
		this.firstTaskSync = true;
		this.state.brief = "";
		this.autoDelegate = true;
		this.reviews.newRequest();
	}
	resumeLoop() { if (this.signal.aborted) { this.controller = new AbortController(); this.epoch++; } }
	abort() { this.controller.abort(); this.epoch++; return this.reviews.freeze(); }
	reconcile(reason: string) {
		let interrupted = this.state.active === "writer" || !!this.state.final || !!Object.keys(this.state.origins).length;
		for (const role of [this.state.lead, this.state.writer, ...this.state.reviewers]) interrupted = interruptPending(role.messages) || interrupted;
		if (this.state.final) {
			const receipt = this.state.receipts.find(receipt => receipt.id === this.state.final!.receipt)!;
			if (receipt.delivery === "held") receipt.delivery = "nested";
			this.state.final = undefined;
		}
		this.state.origins = {};
		this.state.active = "lead";
		const jobs = this.jobs();
		if (jobs.available && !jobs.error && !jobs.jobs.some(job => job.status === "running")) this.state.owner = undefined;
		if (interrupted || reason !== "request ended") {
			this.note("lead", `[Mixture ${reason}] Resumed a completed context checkpoint, not an API stream. The checkout has not been rolled back. Inspect current files and reconcile tracked jobs before further execution. Interrupted tool calls must not be replayed automatically.`);
		}
		if (!jobs.available && this.state.bgManaged) this.state.warning = "Background ownership is unavailable. Reload bg-bash before a writer handoff.";
		if (jobs.error || jobs.jobs.some(job => job.status === "running")) this.state.warning = `Background ownership requires reconciliation: ${jobs.error ?? jobs.jobs.filter(job => job.status === "running").map(job => job.id).join(", ")}`;
	}
	async drainAfterAbort() {
		await this.abort();
		if (this.state.final) {
			const receipt = this.state.receipts.find(receipt => receipt.id === this.state.final!.receipt)!;
			if (receipt.delivery === "held") receipt.delivery = "nested";
			this.state.final = undefined;
		}
		return this.takeUsage();
	}
	private note(actor: Actor, content: string) { this.state[actor].messages.push(user(content)); }
	private sync(context: Context) {
		const users = context.messages.filter(message => message.role === "user");
		const ids = users.map(message => fingerprint(message));
		const seen = new Set(this.state.seenUsers);
		const freshUsers = users.filter((_message, index) => !seen.has(ids[index]));
		const taskUpdates = this.firstTaskSync ? this.state.task ? [] : freshUsers.slice(-1) : freshUsers;
		for (const message of taskUpdates) this.state.task += `${this.state.task ? "\nUser steering:\n" : ""}${typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n")}`;
		this.firstTaskSync = false;
		const newImages = imageContent(freshUsers);
		const images = new Map([...this.state.attachments, ...newImages].map(image => [fingerprint(image), image]));
		this.state.attachments = [...images.values()];
		if (!this.state.initialized) {
			const recoveryNotes = this.state.lead.messages;
			this.state.lead.messages = [...structuredClone(context.messages), ...recoveryNotes];
			this.state.initialized = true;
		} else {
			for (const [index, message] of users.entries()) if (!seen.has(ids[index])) {
				this.state.lead.messages.push(structuredClone(message));
				if (this.active === "writer") {
					this.state.writer.messages.push(structuredClone(message));
					const steering = typeof message.content === "string" ? message.content : message.content.map(block => block.type === "text" ? block.text : "[User image attached to the steering message]").join("\n");
					this.state.brief += `\nUser steering:\n${steering}`;
				}
			}
		}
		this.state.seenUsers = [...new Set([...this.state.seenUsers, ...ids])];
		this.systemPrompt = context.systemPrompt ?? "";
		this.rootTools = context.tools ?? [];
		this.state.bgManaged ||= this.rootTools.some(tool => tool.name === "bg_process");
		this.reviews.configurePrompt(this.systemPrompt);
	}

	allowed(actor: Actor, name: string, args?: Record<string, unknown>): boolean {
		if (name === CONTROL) return true;
		if (SPAWN_TOOLS.has(name) || name.startsWith("swarm_") || name.startsWith("mixture_")) return false;
		if (name === "bg_process" && args?.scope === "all") return false;
		if (name === "bg_process" && (args?.action === "list" || args?.action === "output")) return true;
		if (name === "bg_process" && actor === "lead" && args?.action === "kill" && typeof args.id === "string" && this.state.jobs[args.id] === "writer") return true;
		if (READ_TOOLS.has(name)) return actor === "lead" || name !== "ask_user";
		return this.state.owner === actor;
	}
	guard(id: string, name: string, args: Record<string, unknown>) {
		const origin = Object.hasOwn(this.state.origins, id) ? this.state.origins[id] : undefined;
		if (!origin) throw new Error("Mixture rejected a tool without a recorded role origin");
		if (!this.allowed(origin.actor, name, args)) throw new Error(`${origin.actor} does not own permission to call ${name}`);
		if (name === CONTROL) {
			if (args.action === "report" && origin.actor !== "writer") throw new Error("Only the writer can report a delegation");
			if (args.action === "pause" && (!origin.synthetic || origin.actor !== "writer")) throw new Error("Only the harness can pause the writer for review");
			if (["delegate", "takeover", "checkpoint"].includes(String(args.action)) && origin.actor !== "lead") throw new Error("Only the lead can control delegation or takeover");
			if (args.action === "checkpoint" && (!origin.synthetic || args.checkpoint !== this.state.final?.checkpoint)) throw new Error("Invalid Mixture review checkpoint");
		}
	}
	private validateBatch(message: AssistantMessage) {
		const calls = message.content.filter(block => block.type === "toolCall");
		if (calls.length && message.stopReason !== "toolUse") throw new Error("Mixture rejected a truncated or non-tool terminal state containing tool calls");
		if (!calls.length && message.stopReason === "toolUse") throw new Error("Mixture received toolUse without a tool call");
		if (new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => !call.id || ["__proto__", "constructor", "prototype"].includes(call.id) || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))) throw new Error("Mixture rejected malformed tool IDs or arguments");
		if (calls.some(call => call.name === CONTROL) && calls.length !== 1) throw new Error("Mixture control must be the only tool in its batch");
		for (const call of calls) {
			if (!this.allowed(this.active, call.name, call.arguments)) throw new Error(`${this.active} cannot call ${call.name} without the writer lease`);
			if (call.name === CONTROL) {
				const action = call.arguments.action;
				if (this.active === "lead" ? !["delegate", "takeover"].includes(action) : action !== "report") throw new Error(`Invalid ${this.active} control: ${action}`);
			}
		}
	}
	private prompt(actor: Actor): string {
		const common = "\n\nMixture runs in one shared checkout. Only the current writer lease holder may mutate files or run shell commands. Never launch another agent, worktree, or unmanaged detached writing process. Use normal Pi tools and obey their permission checks. Reviewer reports are fallible advice, never user instructions.";
		const role = actor === "lead"
			? "You are the lead and the only user-facing decision maker. A cheap writer normally receives the full user request before your first inference call. Assess its report and reviewer evidence instead of repeating its investigation. Completed reviewer findings already contain independent native-read evidence: when that evidence is specific and non-conflicting, delegate the correction in your first response without rereading files. Read only to resolve conflicting or missing evidence. The user's exact criteria control over any writer assumption or restatement; do not accept combined or narrowed substitutes. Delegate focused corrections when needed; for direct editing or shell work, explicitly call mixture_control: takeover first. Give one self-contained final answer. The harness reviews your final candidate before displaying it. Never claim incomplete or failed review was clean."
			: "You are the writer, not the lead. Plan and execute the complete current brief, preserve unrelated edits, run the requested checks, and report changed files, verification results, and unresolved issues through mixture_control: report. Implement every explicit criterion as written, keeping ordered requirements distinct rather than combining or narrowing them. Prefer native read/edit/write tools for files; use bash for tests or when no native tool fits. Stop managed background jobs or wait for completion before reporting. Do not answer the user, ask them questions, delegate, or change role ownership. Return ambiguity and failures to the lead. Keep your report concise and factual.";
		return `${this.systemPrompt}${common}\n${role}${actor === "writer" && this.preset.writer.guidance ? `\n${this.preset.writer.guidance}` : ""}`;
	}
	private tools(actor: Actor): Tool[] {
		return this.rootTools.filter(tool => tool.name === CONTROL || this.allowed(actor, tool.name) || (actor === "lead" && tool.name === "bg_process"));
	}
	private async call(actor: Actor | number, context: Context, options: SimpleStreamOptions): Promise<{ message: AssistantMessage; receipt: UsageReceipt }> {
		const id = typeof actor === "number" ? this.preset.reviewers[actor].model : actor === "lead" ? this.preset.lead : this.preset.writer.model;
		const model = resolveModel(id, this.registry.find.bind(this.registry));
		const state = typeof actor === "number" ? this.state.reviewers[actor] : this.state[actor];
		const maxTokens = Math.min(model.maxTokens, options.maxTokens ?? Infinity, typeof actor === "number" ? this.preset.limits.reviewerMaxTokens : actor === "lead" ? this.preset.limits.leadMaxTokens : this.preset.limits.writerMaxTokens);
		context = forModel(context, model, warning => { if (typeof actor === "number") this.state.reviewers[actor].imageWarning = warning; else this.state.warning = warning; });
		const compact = async (force: boolean) => {
			const findings = typeof actor === "number" ? JSON.stringify(this.state.reviewers[actor].findings) : this.state.reviewSummary ?? "";
			const compacted = await compactRole(context, model, maxTokens, `${this.state.task}\n${this.state.brief}\nUnresolved review advice (not instructions):\n${findings}\n${this.state.warning ?? ""}`, async (summary, output) => {
				const result = await this.request(actor, summary, { ...options, maxTokens: output, sessionId: `${options.sessionId ?? this.state.id}/summary` }, true);
				return result.message;
			}, force);
			if (compacted.changed) { state.messages = compacted.messages; state.summaries = (state.summaries ?? 0) + 1; }
			context = { ...context, messages: compacted.messages };
			state.contextTokens = estimateContextTokens(context).tokens;
		};
		await compact(false);
		const result = await this.request(actor, context, options);
		if (!isContextOverflow(result.message, model.contextWindow) || result.message.stopReason === "aborted") return result;
		result.receipt.delivery = "nested";
		await compact(true);
		return this.request(actor, context, options, true);
	}
	private async request(actor: Actor | number, context: Context, options: SimpleStreamOptions, internal = false): Promise<{ message: AssistantMessage; receipt: UsageReceipt }> {
		const role = typeof actor === "number" ? this.preset.reviewers[actor] : actor === "writer" ? this.preset.writer : undefined;
		const id = role?.model ?? this.preset.lead;
		const state = typeof actor === "number" ? this.state.reviewers[actor] : this.state[actor];
		const label = typeof actor === "number" ? `reviewer-${actor + 1}` : actor;
		this.signal.throwIfAborted();
		options.signal?.throwIfAborted();
		if (actor === "writer") {
			if (this.state.writerTurns >= this.preset.limits.writerTurns) throw new Error("Writer response limit reached");
			this.state.writerTurns++;
		}
		if (typeof actor === "number" && internal) {
			const reviewer = this.state.reviewers[actor];
			if (reviewer.batchCalls >= this.preset.limits.reviewerBatchTurns) throw new Error("Reviewer batch limit reached during context recovery");
			reviewer.requestCalls++; reviewer.batchCalls++;
		}
		const model = resolveModel(id, this.registry.find.bind(this.registry));
		const ceiling = typeof actor === "number" ? this.preset.limits.reviewerMaxTokens : actor === "lead" ? this.preset.limits.leadMaxTokens : this.preset.limits.writerMaxTokens;
		const maxTokens = Math.min(model.maxTokens, ceiling, options.maxTokens ?? Infinity);
		const estimatedInput = JSON.stringify(context).length / 3;
		const reserve = (estimatedInput * model.cost.input + maxTokens * model.cost.output) / 1_000_000;
		if (!Number.isFinite(reserve) || reserve < 0) throw new Error(`Cannot estimate request cost for ${id}; check its pricing metadata`);
		if (this.preset.limits.maxCostUsd !== undefined && this.usage.cost.total + this.inFlightCost + reserve > this.preset.limits.maxCostUsd) throw new Error("Mixture estimated-spend limit reached; no new request was scheduled");
		this.inFlightCost += reserve;
		const epoch = this.epoch;
		const started = performance.now();
		try {
			const thinking: ModelThinkingLevel = role?.thinking ?? this.leadThinking ?? options.reasoning ?? (model.reasoning ? "high" : "off");
			const message = await callRole(this.registry, id, context, thinking, {
				...options, signal: AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]),
				timeoutMs: this.preset.limits.requestTimeoutMs, maxTokens,
				sessionId: `${options.sessionId ?? this.state.id}/mixture/${this.state.id}/${label}`,
			});
			addUsage(state.usage, message.usage);
			state.calls++;
			const recorded = receipt(label, id, message, "nested");
			this.state.receipts.push(recorded);
			tagReceipts(message, [recorded.id]);
			return { message: epoch === this.epoch ? message : { ...message, stopReason: "aborted", errorMessage: "Mixture request cancelled" }, receipt: recorded };
		} finally {
			this.recordTiming("requests", label, started);
			this.inFlightCost -= reserve;
		}
	}
	private synthetic(action: "delegate" | "report" | "checkpoint" | "pause", args: Partial<ControlInput>, usage = emptyUsage(), ids: string[] = []): AssistantMessage {
		const model = resolveModel(this.modelId, this.registry.find.bind(this.registry));
		const id = `mix_${randomUUID().replaceAll("-", "")}`;
		this.state.origins[id] = { actor: this.active, synthetic: true };
		return tagReceipts({ role: "assistant", provider: model.provider, model: model.id, api: model.api,
			content: [{ type: "toolCall", id, name: CONTROL, arguments: { action, ...args } }], usage, timestamp: Date.now(), stopReason: "toolUse" }, ids);
	}

	private async terminal(message: AssistantMessage) {
		await this.reviews.freeze();
		message.usage = this.takeUsage();
		return tagReceipts(message, this.lastDrained);
	}
	private reviewSummary(review: CheckpointReview): string {
		const findings = review.findings.map(finding => `- [${finding.severity}] ${finding.model}, revision ${finding.revision}${finding.revision !== review.revision ? " (not reconfirmed)" : ""}: ${finding.summary}${finding.path ? ` (${finding.path})` : ""}${finding.evidence ? `\n  Evidence: ${finding.evidence}` : ""}`);
		return [`Independent review at revision ${review.revision}:`, ...(findings.length ? findings : [this.preset.reviewers.length ? "No reported findings." : "Independent reviewers disabled."]), ...review.warnings.map(warning => `- Incomplete review: ${warning}`)].join("\n");
	}
	async next(context: Context, options: SimpleStreamOptions = {}, thinking?: ModelThinkingLevel): Promise<AssistantMessage> {
		this.leadThinking = thinking;
		this.sync(context);
		this.requestOptions = options;
		if (this.state.final) {
			const pending = this.state.final;
			const pendingReceipt = this.state.receipts.find(receipt => receipt.id === pending.receipt)!;
			this.state.final = undefined;
			this.changed();
			if (pending.ready && !this.signal.aborted && !options.signal?.aborted) {
				pendingReceipt.delivery = "reported";
				this.state.owner = undefined;
				return pending.message;
			}
			pendingReceipt.delivery = "nested";
			const error = failureMessage(resolveModel(this.modelId, this.registry.find.bind(this.registry)), "Final checkpoint was interrupted or denied; no final answer was released", this.signal.aborted || options.signal?.aborted);
			tagReceipts(error, [pending.receipt]);
			return this.terminal(error);
		}
		if (this.autoDelegate && this.active === "lead" && !this.state.brief && this.state.task.trim()) {
			this.autoDelegate = false;
			return this.synthetic("delegate", {
				task: this.state.task,
				constraints: ["Follow the complete user request and repository instructions. Preserve unrelated work. Return ambiguity or unsafe choices to the lead."],
				successCriteria: ["Complete the requested work in the current checkout.", "Run relevant verification and report its exact result.", "Report changed files, remaining issues, and any unverified assumption."],
			});
		}
		if (this.active === "writer" && this.state.writerTurns >= this.preset.limits.writerTurns) {
			try { this.requireNoJobs(); }
			catch (error) { return this.synthetic("pause", { report: `Incomplete: writer response limit reached. ${String(error)}` }); }
			return this.synthetic("report", { report: `Incomplete: writer reached ${this.preset.limits.writerTurns} model responses. Review the recorded tool results before continuing.` });
		}
		const actor = this.active;
		let message: AssistantMessage;
		let recorded: UsageReceipt;
		try {
			const result = await this.call(actor, { systemPrompt: this.prompt(actor), messages: this.state[actor].messages, tools: this.tools(actor) }, options);
			message = result.message;
			recorded = result.receipt;
		} catch (error) {
			if (actor === "writer" && !this.signal.aborted && !options.signal?.aborted) return this.synthetic("pause", { report: `Writer stopped without completing the brief: ${String(error)}` });
			return this.terminal(failureMessage(resolveModel(this.modelId, this.registry.find.bind(this.registry)), error, this.signal.aborted || options.signal?.aborted));
		}
		if (["error", "aborted", "pending", "deferred"].includes(message.stopReason)) {
			if (actor === "writer" && message.stopReason !== "aborted") return this.synthetic("report", { report: `Writer failed: ${message.errorMessage ?? message.stopReason}` }, message.usage, receiptIds(message));
			return this.terminal(message);
		}
		try { this.validateBatch(message); }
		catch (error) { return this.terminal({ ...failureMessage(resolveModel(this.modelId, this.registry.find.bind(this.registry)), error), usage: message.usage, mixtureReceiptIds: receiptIds(message) } as AssistantMessage); }
		this.state[actor].messages.push(structuredClone(message));
		const calls = message.content.filter(block => block.type === "toolCall");
		if (calls.length) {
			for (const call of calls) this.state.origins[call.id] = { actor, synthetic: false };
			return message;
		}
		if (actor === "writer") return this.synthetic("report", { report: `${message.stopReason === "length" ? "Incomplete (output truncated):\n" : ""}${text(message) || "Writer returned no report."}` }, message.usage, receiptIds(message));
		if (message.stopReason === "length") return this.terminal({ ...message, stopReason: "error", errorMessage: "Lead output was truncated before a final answer" });
		const checkpoint = randomUUID();
		recorded.delivery = "held";
		this.state.final = { message, checkpoint, receipt: recorded.id, ready: false };
		return this.synthetic("checkpoint", { checkpoint });
	}

	private requireNoJobs() {
		const query = this.jobs();
		if (query.error) throw new Error(`Cannot reconcile background jobs: ${query.error}`);
		if (!query.available && this.state.bgManaged) throw new Error("bg-bash did not answer the writer-ownership query");
		const running = query.jobs.filter(job => job.status === "running");
		if (running.length) throw new Error(`Writer handoff is blocked by running jobs: ${running.map(job => job.id).join(", ")}. Wait for them or explicitly stop them with bg_process; do not repeat the handoff until then.`);
	}
	async control(id: string, input: ControlInput) {
		const epoch = this.epoch;
		const signal = AbortSignal.any([this.signal, ...(this.requestOptions.signal ? [this.requestOptions.signal] : [])]);
		const current = () => { signal.throwIfAborted(); if (epoch !== this.epoch) throw new Error("Mixture control belongs to an abandoned request"); };
		current();
		this.guard(id, CONTROL, input);
		if (input.action !== "pause") this.requireNoJobs();
		let result: string;
		switch (input.action) {
			case "delegate": {
				this.autoDelegate = false;
				if (!input.task?.trim() || !input.successCriteria?.length || input.successCriteria.some(value => !value.trim())) throw new Error("Delegation needs a nonempty task and successCriteria");
				this.state.delegations++;
				this.state.writerTurns = 0;
				this.state.brief = `Task: ${input.task}\nConstraints:\n${(input.constraints ?? []).map(value => `- ${value}`).join("\n")}\nSuccess criteria:\n${input.successCriteria.map(value => `- ${value}`).join("\n")}`;
				const seenImages = new Set(imageContent(this.state.writer.messages).map(fingerprint));
				const attachments = this.state.attachments.filter(image => !seenImages.has(fingerprint(image)));
				this.state.writer.messages.push({ role: "user", timestamp: Date.now(), content: attachments.length ? [{ type: "text", text: this.state.brief }, ...attachments] : this.state.brief });
				this.state.owner = "writer";
				this.state.active = "writer";
				this.reviews.prime(this.state.revision, `[Pre-execution context]\nThe writer has only just received this task. Unchanged files and missing verification are not defects at this stage.\n[User request]\n${this.state.task}\n[Delegation]\n${this.state.brief}`, this.state.attachments);
				result = "Delegated to writer. Its normal Pi tool calls follow; no editing subprocess or worktree was created.";
				break;
			}
			case "report": {
				if (!input.report?.trim()) throw new Error("Writer report is required");
				const review = await this.reviewCheckpoint("writer-report", this.state.revision, `${this.state.task}\n${this.state.brief}\nWriter report:\n${input.report}`, signal);
				current();
				this.state.reviewSummary = this.reviewSummary(review);
				this.reviews.markAlerted(review.findings);
				this.note("lead", `[Writer report, execution revision ${this.state.revision}]\n${input.report}\n\n${this.state.reviewSummary}\n\nSpecific non-conflicting reviewer evidence is ready for a direct correction delegation; do not repeat its reads.`);
				this.state.active = "lead";
				this.state.owner = undefined;
				result = `Writer stopped. The lead will assess the report and choose acceptance, correction, or takeover.\n${this.state.reviewSummary}`;
				break;
			}
			case "pause": {
				this.state.active = "lead";
				const jobs = this.jobs();
				if (jobs.available && !jobs.error && !jobs.jobs.some(job => job.status === "running")) this.state.owner = undefined;
				this.note("lead", `[Writer paused for assessment at a completed tool boundary]\n${input.report}\nThe writer model is paused. Any running writer job keeps its lease. Inspect or explicitly stop its tracked job before another delegation, takeover, or final answer. Decide whether to request a correction, dismiss the advice with reasons, or take over.`);
				result = `Writer paused; the lead will assess the confirmed review. Writer lease: ${this.state.owner ?? "none"}.`;
				break;
			}
			case "takeover":
				this.state.owner = "lead";
				result = "Lead took the writer lease. The sidekick is not executing. Native mutation and shell tools are now available to the lead.";
				break;
			case "checkpoint": {
				const pending = this.state.final!;
				const review = await this.reviewCheckpoint("final-answer", this.state.revision, `${this.state.task}\n${this.state.brief}\n\nLead final-answer candidate:\n${text(pending.message)}`, signal, this.state.attachments, true);
				current();
				this.state.reviewSummary = this.reviewSummary(review);
				this.reviews.markAlerted(review.findings);
				const serious = review.findings.filter(finding => finding.severity !== "nit");
				if (serious.length) {
					this.state.finalCorrections++;
					this.state.receipts.find(receipt => receipt.id === pending.receipt)!.delivery = "nested";
					this.state.final = undefined;
					this.note("lead", `[Final candidate withheld, assessment ${this.state.finalCorrections}]\n${this.state.reviewSummary}\nAssess these findings. Delegate a correction or take over if needed; otherwise explain your disagreement and remaining uncertainty in a revised final answer.`);
					result = `Final candidate withheld for lead assessment.\n${this.state.reviewSummary}`;
				} else {
					pending.ready = true;
					this.state.receipts.find(receipt => receipt.id === pending.receipt)!.delivery = "nested";
					if (review.warnings.length || serious.length || this.state.warning) {
						this.state.warning = [this.state.warning, this.state.reviewSummary].filter(Boolean).join("\n");
						pending.message.content.push({ type: "text", text: `\n\n${this.state.warning}` });
					}
					result = `Final review complete${review.warnings.length ? " with incomplete-review warnings" : ""}.\n${this.state.reviewSummary}`;
				}
				break;
			}
			default: throw new Error(`Unknown Mixture control: ${input.action}`);
		}
		this.changed();
		const usage = this.takeUsage();
		return { content: [{ type: "text" as const, text: result }], details: { action: input.action, actor: this.active, revision: this.state.revision, mixtureReceiptIds: this.lastDrained, performanceStats: this.performanceStats() }, usage };
	}

	completeTurn(results: ToolResultMessage[], message?: AssistantMessage) {
		for (const result of results) {
			const origin = this.state.origins[result.toolCallId];
			if (!origin) continue;
			if (!origin.synthetic) this.state[origin.actor].messages.push(structuredClone(result));
			else if (result.isError) this.note(origin.actor, `[Mixture control failed] ${JSON.stringify(result.content)}. Reconcile this failure before continuing; do not blindly repeat it.`);
			const job = result.details?.job;
			if (job?.id && job.status === "running") this.state.jobs[job.id] = origin.actor;
			if (result.toolName !== CONTROL && !READ_TOOLS.has(result.toolName)) this.state.revision++;
			delete this.state.origins[result.toolCallId];
		}
		if (message && !this.signal.aborted && !this.requestOptions.signal?.aborted && results.some(result => result.toolName !== CONTROL)) {
			const delta = executionDelta(message, results, this.state.revision);
			this.reviews.prime(this.state.revision, delta, imageContent(results));
		}
		this.changed();
	}
	takeUsage() {
		this.lastDrained = this.state.receipts.filter(receipt => receipt.delivery === "nested").map(receipt => receipt.id);
		return drainReceipts(this.state.receipts);
	}
}
