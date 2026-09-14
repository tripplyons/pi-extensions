import { createHash, randomUUID } from "node:crypto";
import { StringEnum, isContextOverflow, type AssistantMessage, type Context, type ImageContent, type Message, type ModelThinkingLevel, type SimpleStreamOptions, type Tool, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { compactRole, estimateContextTokens, forModel, imageContent, interruptPending } from "./context.ts";
import type { BackgroundJobQuery } from "../bg-bash/events.ts";
import type { Preset } from "./config.ts";
import { addUsage, callRole, emptyUsage, failureMessage, resolveModel, type Registry } from "./provider.ts";
import { adoptLegacyPhase, assessPhase, delegatePhase, phaseFields, phaseSummary, phaseUpdatesSummary, recordPhaseUpdate, type ImmediateAction, type PhaseState } from "./phase.ts";
import { executionDelta, newReviewer, ReviewPool, type CheckpointReview, type ReviewerState } from "./review.ts";
import { drainReceipts, receipt, receiptIds, tagReceipts, type UsageReceipt } from "./usage.ts";

export const CONTROL = "mixture_control";
const controlParams = (actions: string[]) => Type.Object({
	action: StringEnum(actions),
	...phaseFields,
	message: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
	report: Type.Optional(Type.String()),
	checkpoint: Type.Optional(Type.String()),
});
export const ControlParams = controlParams(["delegate", "assess", "update", "report", "escalate", "takeover", "checkpoint", "pause"]);
export type ControlInput = Static<typeof ControlParams>;
export const controlTool: Tool = {
	name: CONTROL,
	description: "Mixture role coordination. Lead: delegate a bounded task with nextAction, acceptedEvidence, constraints and successCriteria. At handoffs, assess the current phaseId with evidence before continuing it. Two failed corrective attempts block equivalent delegation; reopening requires changedPrerequisite evidence. Update an active writer after user steering, or explicitly take over after the writer stops. Writer: report only when the delegated work is complete, or escalate an ambiguity, blocker, failure, or required user decision. The harness schedules reviews and decides handoff timing. Never combine a control with other tool calls. Checkpoint and pause are reserved for the harness.",
	parameters: ControlParams,
};
export type Actor = "lead" | "writer";
interface Origin { actor: Actor; synthetic: boolean }
export interface RoleState { messages: Message[]; usage: Usage; calls: number; summaries?: number; contextTokens?: number }
export interface TimingAggregate { count: number; totalMs: number; maxMs: number; lastMs: number }
export interface PerformanceStats {
	requests: Record<string, TimingAggregate>;
	checkpoints: Record<string, TimingAggregate>;
	coordination?: CoordinationStats;
}
export type CoordinationEventKind = "review-scheduled" | "feedback-delivered" | "lead-checkpoint" | "writer-escalation";
export interface CoordinationEvent { kind: CoordinationEventKind; revision: number; sequence?: number }
export interface CoordinationStats { scheduledReviews: number; deliveredReviews: number; leadCheckpoints: number; escalations: number; recent: CoordinationEvent[] }
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
	phase?: PhaseState;
	task: string;
	attachments: ImageContent[];
	revision: number;
	delegations: number;
	writerTurns: number;
	writerRetries?: number;
	writerRetryDelegation?: number;
	writerReportRejections?: number;
	writerBatches?: number;
	writerReviewSequences?: number[];
	writerReviewsDelivered?: number;
	writerProgress?: string[];
	immediateAction?: ImmediateAction;
	coordination?: CoordinationStats;
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
		delegations: 0, writerTurns: 0, writerRetries: 0, writerRetryDelegation: 0, writerReportRejections: 0, writerBatches: 0, writerReviewSequences: [], writerReviewsDelivered: 0, writerProgress: [],
		coordination: { scheduledReviews: 0, deliveredReviews: 0, leadCheckpoints: 0, escalations: 0, recent: [] }, finalCorrections: 0, jobs: {}, bgManaged: false, origins: {} };
}
const text = (message: AssistantMessage) => message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const retryableWriterFailure = (message: AssistantMessage) => message.stopReason === "error" && message.usage.output === 0
	&& !message.content.some(block => block.type === "toolCall")
	&& /websocket|connection|network|socket|fetch failed|ECONN|ETIMEDOUT|timed? ?out|timeout/i.test(message.errorMessage ?? "");
const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });
function executionProgress(message: AssistantMessage, results: ToolResultMessage[], revision: number) {
	const lines = message.content.filter(block => block.type === "toolCall").map(call => {
		const result = results.find(item => item.toolCallId === call.id);
		const target = typeof call.arguments.path === "string" ? call.arguments.path
			: typeof call.arguments.command === "string" ? call.arguments.command.replaceAll(/\s+/g, " ").slice(0, 240)
			: JSON.stringify(call.arguments).slice(0, 240);
		const output = result?.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim() ?? "No result recorded";
		const evidence = (call.name === "bash" || result?.isError ? output.slice(-1_200) : output.slice(-240)).replaceAll(/\s+/g, " ");
		return `- ${call.name}${target ? ` ${target}` : ""}: ${result?.isError ? "FAILED" : result ? "success" : "unknown"}${evidence ? ` — ${evidence}` : ""}`;
	});
	return `[Execution revision ${revision}]\n${lines.join("\n")}`;
}
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "web_run", "get_goal"]);
const LEAD_SESSION_TOOLS = new Set(["ask_user", "create_goal", "update_goal"]);
const CHECKOUT_NEUTRAL_TOOLS = new Set([...READ_TOOLS, ...LEAD_SESSION_TOOLS, "bg_process", "sleep"]);
const NESTED_AGENT_TOOLS = new Set(["subagent", "subagent_process"]);
const MAX_FINAL_CORRECTIONS_PER_REVISION = 2;

export class MixtureSession {
	readonly state: MixtureState;
	private controller = new AbortController();
	private epoch = 0;
	private inFlightCost = 0;
	private running = false;
	private reviewing = false;
	private requestOptions: SimpleStreamOptions = {};
	private leadThinking?: ModelThinkingLevel;
	lastDrained: string[] = [];
	private systemPrompt = "";
	private firstTaskSync = true;
	private rootTools: Tool[] = [];
	private readonly timings: PerformanceStats = { requests: {}, checkpoints: {} };
	readonly reviews: ReviewPool;
	constructor(readonly preset: Preset, readonly registry: Registry, state: MixtureState,
		private readonly jobs: () => BackgroundJobQuery,
		private readonly changed: () => void = () => {}, cwd = process.cwd()) {
		this.state = state;
		this.state.writerRetries ??= 0;
		this.state.writerRetryDelegation ??= 0;
		this.state.writerReportRejections ??= 0;
		this.state.writerBatches ??= 0;
		this.state.writerReviewSequences ??= [];
		this.state.writerReviewsDelivered ??= 0;
		this.state.writerProgress ??= [];
		if (!this.state.phase && this.state.brief.trim()) this.state.phase = adoptLegacyPhase(this.state.brief);
		this.state.coordination ??= { scheduledReviews: 0, deliveredReviews: 0, leadCheckpoints: 0, escalations: 0, recent: [] };
		this.reviews = new ReviewPool(preset, state.reviewers, cwd, async (index, context, signal) => {
			const result = await this.call(index, context, { ...this.requestOptions,
				signal: AbortSignal.any([signal, ...(this.requestOptions.signal ? [this.requestOptions.signal] : [])]) });
			return result.message;
		}, id => resolveModel(id, registry.find.bind(registry)).input.includes("image"), changed);
		if (state.task || state.brief) this.reviews.configureScope(this.currentScope(), state.attachments);
	}

	private currentScope() {
		const updates = phaseUpdatesSummary(this.state.phase, this.state.phase?.attempt);
		return `${this.state.task}\n\n${this.state.brief}${updates ? `\n\n${updates}` : ""}`;
	}
	get signal() { return this.controller.signal; }
	get active() { return this.state.active; }
	get activity() {
		const { active, owner, phase, final } = this.state;
		if (this.running && this.reviewing) return "reviewing";
		if (active === "lead" && owner !== "lead" && (phase?.assessment === "blocked" || phase?.assessment === "stalled" && phase.failedCorrections >= 2)) return "blocked";
		if (!this.running) return "idle";
		if (active === "writer" || owner === "lead") return "working";
		if (final) return "finishing";
		return phase && !["complete", "superseded"].includes(phase.assessment ?? "") ? "assessing" : "planning";
	}
	get modelId() { return this.active === "lead" ? this.preset.lead : this.preset.writer.model; }
	performanceStats(): PerformanceStats { return { ...structuredClone(this.timings), coordination: structuredClone(this.state.coordination) }; }
	private recordTiming(group: "requests" | "checkpoints", name: string, started: number) {
		const elapsed = Math.max(0, performance.now() - started);
		const current = this.timings[group][name] ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
		current.count++;
		current.totalMs += elapsed;
		current.maxMs = Math.max(current.maxMs, elapsed);
		current.lastMs = elapsed;
		this.timings[group][name] = current;
	}
	private recordCoordination(kind: CoordinationEventKind, sequence?: number, count = 1) {
		const coordination = this.state.coordination!;
		if (kind === "review-scheduled") coordination.scheduledReviews += count;
		else if (kind === "feedback-delivered") coordination.deliveredReviews += count;
		else if (kind === "lead-checkpoint") coordination.leadCheckpoints += count;
		else coordination.escalations += count;
		coordination.recent.push({ kind, revision: this.state.revision, ...(sequence === undefined ? {} : { sequence }) });
		if (coordination.recent.length > 64) coordination.recent.splice(0, coordination.recent.length - 64);
	}
	private async reviewCheckpoint(kind: "writer-report" | "writer-escalation" | "final-answer", revision: number, content: string, signal?: AbortSignal, images?: ImageContent[], candidateOnly = false) {
		const started = performance.now();
		const epoch = this.epoch;
		this.reviewing = this.state.reviewers.length > 0;
		this.changed();
		try { return await this.reviews.checkpoint(revision, content, signal, images, candidateOnly); }
		finally {
			if (epoch === this.epoch) this.reviewing = false;
			this.recordTiming("checkpoints", kind, started);
			this.changed();
		}
	}
	get usage() {
		const total = emptyUsage();
		for (const role of [this.state.lead, this.state.writer, ...this.state.reviewers]) addUsage(total, role.usage);
		return total;
	}
	rootContextTokens() {
		return Math.max(1, estimateContextTokens({ systemPrompt: this.prompt("lead"), messages: this.state.lead.messages, tools: this.tools("lead") }).tokens);
	}
	resourceSessionIds(rootSessionId: string) {
		const base = `${rootSessionId}/mixture/${this.state.id}`;
		return [`${rootSessionId}/summary`, `${base}/lead`, `${base}/writer`, ...this.state.reviewers.map((_reviewer, index) => `${base}/reviewer-${index + 1}`)];
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
		this.state.writerRetries = 0;
		this.state.writerRetryDelegation = 0;
		this.state.writerReportRejections = 0;
		this.state.finalCorrections = 0;
		this.state.warning = undefined;
		this.state.task = task;
		this.state.attachments = [];
		this.state.active = "lead";
		this.firstTaskSync = true;
		this.state.brief = this.state.phase ? phaseSummary(this.state.phase, false) : "";
		this.resetWriterWindow();
		this.reviews.newRequest();
		this.running = true;
		this.reviewing = false;
		this.changed();
	}
	resumeLoop() {
		if (this.signal.aborted) { this.controller = new AbortController(); this.epoch++; }
		this.running = true;
		this.changed();
	}
	abort() {
		this.controller.abort(); this.epoch++;
		this.running = false; this.reviewing = false;
		this.changed();
		return this.reviews.freeze();
	}
	reconcile(reason: string) {
		this.running = false;
		this.reviewing = false;
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
		this.changed();
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
	private removeNotes(actor: Actor, ...prefixes: string[]) {
		this.state[actor].messages = this.state[actor].messages.filter(message => {
			if (message.role !== "user" || typeof message.content !== "string") return true;
			const content = message.content;
			return !prefixes.some(prefix => content.startsWith(prefix));
		});
	}
	private replaceNote(actor: Actor, prefix: string, content: string) {
		this.removeNotes(actor, prefix);
		this.note(actor, content);
	}
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
			const writerWasActive = this.active === "writer";
			for (const [index, message] of users.entries()) if (!seen.has(ids[index])) this.state.lead.messages.push(structuredClone(message));
			if (writerWasActive && freshUsers.length) {
				this.state.active = "lead";
				this.replaceNote("lead", "[Harness user steering requires lead assessment", "[Harness user steering requires lead assessment]\nThe writer is paused at a model boundary and retains its lease. Assess the new user message before calling mixture_control: update with the relevant direction. Do not delegate a second phase over the active lease. Take over only if the writer should stop executing.");
			}
		}
		this.state.seenUsers = [...new Set([...this.state.seenUsers, ...ids])];
		this.systemPrompt = context.systemPrompt ?? "";
		this.rootTools = context.tools ?? [];
		this.state.bgManaged ||= this.rootTools.some(tool => tool.name === "bg_process");
		this.reviews.configurePrompt(this.systemPrompt);
		if (this.state.phase) this.replaceNote("lead", "[Harness phase tracking]", phaseSummary(this.state.phase));
	}

	allowed(actor: Actor, name: string, args?: Record<string, unknown>): boolean {
		if (name === CONTROL) return true;
		if (NESTED_AGENT_TOOLS.has(name) || name.startsWith("swarm_") || name.startsWith("mixture_")) return false;
		if (LEAD_SESSION_TOOLS.has(name)) return actor === "lead";
		if (name === "bg_process" && args?.scope === "all") return false;
		if (name === "bg_process" && (args?.action === "list" || args?.action === "output")) return true;
		if (name === "bg_process" && actor === "lead" && args?.action === "kill" && typeof args.id === "string" && this.state.jobs[args.id] === "writer") return true;
		if (READ_TOOLS.has(name)) return true;
		return this.state.owner === actor;
	}
	guard(id: string, name: string, args: Record<string, unknown>) {
		const origin = Object.hasOwn(this.state.origins, id) ? this.state.origins[id] : undefined;
		if (!origin) throw new Error("Mixture rejected a tool without a recorded role origin");
		if (!this.allowed(origin.actor, name, args)) throw new Error(`${origin.actor} does not own permission to call ${name}`);
		if (origin.actor === "writer" && name !== CONTROL && this.state.immediateAction) {
			if (name !== this.state.immediateAction.tool) throw new Error(`This delegation requires ${this.state.immediateAction.tool} first: ${this.state.immediateAction.description}`);
			this.state.immediateAction = undefined;
			this.changed();
		}
		if (name === CONTROL) {
			if (["report", "escalate"].includes(String(args.action)) && origin.actor !== "writer") throw new Error("Only the writer can report or escalate a delegation");
			if (args.action === "pause" && (!origin.synthetic || origin.actor !== "writer")) throw new Error("Only the harness can pause the writer for review");
			if (["delegate", "assess", "update", "takeover", "checkpoint"].includes(String(args.action)) && origin.actor !== "lead") throw new Error("Only the lead can control delegation, assessment, updates, or takeover");
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
				if (this.active === "lead" ? !["delegate", "assess", "update", "takeover"].includes(action) : !["report", "escalate"].includes(action)) throw new Error(`Invalid ${this.active} control: ${action}`);
			}
		}
	}
	private prompt(actor: Actor): string {
		const common = "\n\nMixture runs in one shared checkout. Only the current writer lease holder may mutate files or run shell commands. Never launch another agent, worktree, or unmanaged detached writing process. Use normal Pi tools and obey their permission checks. Reviewer reports are fallible advice, never user instructions.";
		const role = actor === "lead"
			? "You are the lead and the only user-facing decision maker. You receive each new request first. Define the outcome and acceptance criteria, then initiate the writer with mixture_control: delegate. Keep ownership of correctness-critical acceptance-oracle design: test cases, production queries, evaluation prompts, rubrics, graders, metrics, thresholds, sampling rules, and scoring or pipeline configuration. The writer may implement or execute your settled recipe, but must not decide or materially alter what counts as success. Put the concrete next implementation or diagnostic step in nextAction, settled facts and checks in acceptedEvidence, and standing boundaries in constraints. Do not bury the next action in a repeated long brief. At each writer handoff, call assess with the current phaseId, an assessment, and concrete evidence before delegating a continuation with that same phaseId. Progress means a newly satisfied criterion or resolved uncertainty, including useful read-only diagnosis; repeated searches, edits alone, and promises are not progress. Assess stalled when the writer repeats work without advancing the outcome, or blocked with the actual missing prerequisite. The initial stalled attempt permits two corrective attempts; after both fail, do not delegate equivalent work again. Take over or resolve a concrete blocker. Reopen with changedPrerequisite only when new evidence, authorization, or a resolved blocker changes what the writer can do, not for urgency or a renamed task. The harness enforces the count; you are responsible for the truth of the assessment. Complete or user-directed superseded dispositions need evidence before starting a new phase. Ask the user first only when authorization or missing information changes correctness. If and only if the harness says new user steering arrived while the writer retains its lease, assess it and use mixture_control: update to send one consolidated direction into that persistent context. At progress, completion, or correction checkpoints the writer lease has been released, so assess before delegate rather than using update. Use the harness phase record across new requests and compaction; a new prompt does not erase a stalled attempt. At checkpoints, use recorded execution and reviewer evidence instead of repeating the investigation, then assess and continue, take over, ask a necessary question, or finish. Do not mark blocked or unfinished obligations complete to obtain another writer budget. Completed reviewer findings already contain independent native-read evidence: read only to resolve conflicting or missing evidence. The user's exact criteria control over any writer assumption or restatement; do not accept combined or narrowed substitutes. For direct editing or shell work, explicitly call mixture_control: takeover first. Give one self-contained final answer. The harness reviews your final candidate before displaying it. Never claim incomplete or failed review was clean."
			: "You are the writer, not the lead. Start with the brief's next action and execute it, checking it against the original phase criteria and standing constraints. Do not author or materially alter the acceptance oracle: test cases, production queries, evaluation prompts, rubrics, graders, metrics, thresholds, sampling rules, or scoring and pipeline configuration. You may implement or run the lead's settled recipe. Escalate before changing what counts as success. Accepted evidence is settled: do not repeat those reads or checks unless new conflicting evidence makes rechecking necessary. Plan against every item in the complete current brief before editing, then execute it without waiting for the reviewer to discover omissions. A narrower current step does not replace phase acceptance. If the next action cannot be performed, identify the concrete blocker rather than looping through the same research. Work only from the current checkout and paths the user explicitly supplied; do not search other projects, temporary directories, sessions or prior outputs for a solution. Batch independent reads, edits and checks in one tool-call response when safe, but keep dependent mutations ordered. Reviewer updates arrive automatically every few completed tool batches; correct supported findings without checking in with the lead, and let later review recheck them. Before reporting, self-review every success criterion and run the relevant focused edge checks. Use mixture_control: report only when the delegated work is complete. Use mixture_control: escalate only for an ambiguity, blocker, failure, or required user decision that you cannot resolve within the brief. The harness, not you, controls routine review and lead-checkpoint timing. Preserve unrelated edits and report changed files, verification results and remaining issues. Implement every explicit criterion as written, keeping ordered requirements distinct rather than combining or narrowing them. Prefer native read/edit/write tools for files; use bash for tests or when no native tool fits. Stop managed background jobs or wait for completion before reporting or escalating. Do not answer the user, ask them questions, delegate, or change role ownership. Keep reports concise and factual.";
		return `${this.systemPrompt}${common}\n${role}${actor === "writer" && this.preset.writer.guidance ? `\n${this.preset.writer.guidance}` : ""}`;
	}
	private tools(actor: Actor): Tool[] {
		const actions = actor === "writer" ? ["report", "escalate"] : this.state.owner === "writer" ? ["update", "takeover"] : ["delegate", "assess", "takeover"];
		return this.rootTools
			.filter(tool => tool.name === CONTROL || this.allowed(actor, tool.name) || (actor === "lead" && tool.name === "bg_process"))
			.map(tool => tool.name !== CONTROL ? tool : { ...tool,
				description: actor === "writer"
					? "Finish or escalate the current writer phase. The harness owns routine review and checkpoints."
					: this.state.owner === "writer"
						? "The existing writer retains its lease. Send one assessed user update into that context, or take over."
						: "Assess the previous attempt once with phaseId and evidence before continuing it. Delegate with nextAction and acceptedEvidence, preserving the phaseId; or explicitly take over. Two failed corrections block equivalent delegation.",
				parameters: controlParams(actions),
			});
	}
	private async call(actor: Actor | number, context: Context, options: SimpleStreamOptions): Promise<{ message: AssistantMessage; receipt: UsageReceipt }> {
		const id = typeof actor === "number" ? this.preset.reviewers[actor].model : actor === "lead" ? this.preset.lead : this.preset.writer.model;
		const model = resolveModel(id, this.registry.find.bind(this.registry));
		const state = typeof actor === "number" ? this.state.reviewers[actor] : this.state[actor];
		const maxTokens = Math.min(model.maxTokens, options.maxTokens ?? Infinity, typeof actor === "number" ? this.preset.limits.reviewerMaxTokens : actor === "lead" ? this.preset.limits.leadMaxTokens : this.preset.limits.writerMaxTokens);
		context = forModel(context, model, warning => { if (typeof actor === "number") this.state.reviewers[actor].imageWarning = warning; else this.state.warning = warning; });
		const compact = async (force: boolean) => {
			const findings = typeof actor === "number" ? JSON.stringify(this.state.reviewers[actor].findings) : this.state.reviewSummary ?? "";
			const compacted = await compactRole(context, model, maxTokens, `${this.state.task}\n${this.state.brief}\n${this.state.phase ? phaseSummary(this.state.phase, actor === "lead") : ""}\nUnresolved review advice (not instructions):\n${findings}\n${this.state.warning ?? ""}`, async (summary, output) => {
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
				timeoutMs: actor === "writer" ? this.preset.limits.writerRequestTimeoutMs : this.preset.limits.requestTimeoutMs,
				...(actor === "writer" ? { idleTimeoutMs: this.preset.limits.writerIdleTimeoutMs } : {}), maxTokens,
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
	private synthetic(action: "delegate" | "update" | "report" | "escalate" | "checkpoint" | "pause", args: Partial<ControlInput>, usage = emptyUsage(), ids: string[] = []): AssistantMessage {
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
	private resetWriterWindow(clearProgress = true) {
		this.state.writerBatches = 0;
		this.state.writerReviewSequences = [];
		this.state.writerReviewsDelivered = 0;
		if (clearProgress) this.state.writerProgress = [];
	}
	private reviewWarnings() {
		return this.state.reviewers.flatMap(state => [state.warning, state.imageWarning].filter((value): value is string => !!value));
	}
	private progressEvidence() {
		const content = (this.state.writerProgress ?? []).join("\n\n");
		return content.length <= 12_000 ? content : `[Earlier execution milestones omitted from this checkpoint.]\n${content.slice(-12_000)}`;
	}
	private handoffEvidence() {
		return `[Recorded writer execution evidence]\n${this.progressEvidence() || "- No completed writer tool batches were recorded."}`;
	}
	private prepareWriterTurn() {
		if (this.state.active !== "writer" || !this.state.reviewers.length) return;
		const sequences = this.state.writerReviewSequences ?? [];
		const delivered = this.state.writerReviewsDelivered ?? 0;
		const completed = sequences.filter(sequence => this.state.reviewers.every(state => state.sequence >= sequence)).length;
		const incomplete = delivered < sequences.length && this.state.reviewers.some(state => state.status === "incomplete");
		if (completed <= delivered && !incomplete) return;
		this.state.writerReviewsDelivered = incomplete ? sequences.length : completed;
		const newlyDelivered = this.state.writerReviewsDelivered - delivered;
		this.recordCoordination("feedback-delivered", sequences[this.state.writerReviewsDelivered - 1], newlyDelivered);
		const review = { revision: this.state.revision, findings: this.reviews.findings, warnings: this.reviewWarnings() };
		const summary = this.reviewSummary(review);
		this.state.reviewSummary = summary;
		this.replaceNote("writer", "[Harness reviewer feedback", `[Harness reviewer feedback after ${this.state.writerReviewsDelivered} scheduled review cycle(s)]\n${summary}\nAddress supported findings within the writer phase. Routine review does not require a lead check-in.`);
		if (!incomplete && completed < this.preset.limits.leadEveryReviews) return;
		try { this.requireNoJobs(); }
		catch (error) {
			const warning = `Harness lead checkpoint deferred until writer jobs are reconciled: ${String(error)}`;
			if (this.state.warning !== warning) { this.state.warning = warning; this.note("writer", `[${warning}]`); }
			return;
		}
		const started = performance.now();
		const checkpoint = this.reviews.snapshot(this.state.revision);
		this.recordTiming("checkpoints", "writer-progress", started);
		this.recordCoordination("lead-checkpoint", sequences[this.state.writerReviewsDelivered - 1]);
		this.state.reviewSummary = this.reviewSummary(checkpoint);
		this.reviews.markAlerted(checkpoint.findings);
		this.replaceNote("lead", "[Harness writer-progress checkpoint", `[Harness writer-progress checkpoint, execution revision ${this.state.revision}]\nThe writer has not claimed completion. The harness paused it after ${this.state.writerReviewsDelivered} scheduled review cycles and ${this.state.writerTurns} writer responses in this phase.\n\n${this.progressEvidence()}\n\n${this.state.reviewSummary}\n\nAssess this attempt once with phaseId and evidence before delegating a continuation. Preserve the failed-correction count; do not rename the phase to reset it. Take over, ask for a required decision, or finish only if the task is actually complete.`);
		this.state.active = "lead";
		this.state.owner = undefined;
	}
	async next(context: Context, options: SimpleStreamOptions = {}, thinking?: ModelThinkingLevel): Promise<AssistantMessage> {
		this.running = true;
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
		this.prepareWriterTurn();
		this.changed();
		if (this.active === "writer" && this.state.writerTurns >= this.preset.limits.writerTurns) {
			try { this.requireNoJobs(); }
			catch (error) { return this.synthetic("pause", { report: `Incomplete: writer response limit reached. ${String(error)}` }); }
			return this.synthetic("escalate", { report: `Incomplete: writer reached ${this.preset.limits.writerTurns} model responses. Review the recorded tool results before continuing.` });
		}
		const actor = this.active;
		let message: AssistantMessage;
		let recorded: UsageReceipt;
		try {
			const context = { systemPrompt: this.prompt(actor), messages: this.state[actor].messages, tools: this.tools(actor) };
			let result = await this.call(actor, context, options);
			if (actor === "writer" && retryableWriterFailure(result.message) && this.state.writerRetryDelegation !== this.state.delegations && this.state.writerTurns < this.preset.limits.writerTurns) {
				this.state.writerRetries = (this.state.writerRetries ?? 0) + 1;
				this.state.writerRetryDelegation = this.state.delegations;
				this.note("writer", `[Harness retry after transient provider failure: ${result.message.errorMessage ?? "network error"}. The failed request produced no tool call, so no tool ran and no checkout changes or completed writer history were reverted.]`);
				result = await this.call(actor, { ...context, messages: this.state.writer.messages }, options);
			}
			message = result.message;
			recorded = result.receipt;
		} catch (error) {
			if (actor === "writer" && !this.signal.aborted && !options.signal?.aborted) return this.synthetic("escalate", { report: `Writer stopped without completing the brief: ${String(error)}` });
			return this.terminal(failureMessage(resolveModel(this.modelId, this.registry.find.bind(this.registry)), error, this.signal.aborted || options.signal?.aborted));
		}
		if (["error", "aborted", "pending", "deferred"].includes(message.stopReason)) {
			if (actor === "writer" && message.stopReason !== "aborted") return this.synthetic("escalate", { report: `Writer failed: ${message.errorMessage ?? message.stopReason}` }, message.usage, receiptIds(message));
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
		if (actor === "writer") return this.synthetic(message.stopReason === "length" ? "escalate" : "report", { report: `${message.stopReason === "length" ? "Incomplete (output truncated):\n" : ""}${text(message) || "Writer returned no report."}` }, message.usage, receiptIds(message));
		if (this.state.owner === "writer") return this.synthetic("update", { message: text(message) || "Continue the current writer plan while incorporating the latest user direction." }, message.usage, receiptIds(message));
		if (this.state.delegations === 0 && !this.state.phase) return this.terminal({ ...failureMessage(resolveModel(this.modelId, this.registry.find.bind(this.registry)), "Lead ended before initiating the required writer phase"), usage: message.usage, mixtureReceiptIds: receiptIds(message) } as AssistantMessage);
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
		if (input.action !== "pause" && input.action !== "update") this.requireNoJobs();
		let result: string;
		switch (input.action) {
			case "delegate": {
				if (this.state.owner === "writer") throw new Error("The writer already holds the lease; assess steering with update or explicitly take over");
				const previousPhase = this.state.phase;
				const delegated = delegatePhase(previousPhase, input);
				if (input.immediateAction && this.rootTools.length && !this.rootTools.some(tool => tool.name === input.immediateAction!.tool && tool.name !== CONTROL)) throw new Error(`Immediate-action tool is not available to the writer: ${input.immediateAction.tool}`);
				if (delegated.phase.id !== previousPhase?.id) {
					await this.reviews.startPhase();
					current();
					this.state.reviewSummary = undefined;
					this.state.finalCorrections = 0;
				}
				this.state.phase = delegated.phase;
				this.state.immediateAction = input.immediateAction ? { tool: input.immediateAction.tool.trim(), description: input.immediateAction.description.trim() } : undefined;
				this.state.delegations++;
				this.state.writerTurns = 0;
				this.state.writerReportRejections = 0;
				this.resetWriterWindow();
				this.state.brief = delegated.brief;
				this.removeNotes("writer", "[Harness reviewer feedback", "[Harness rejected the completion report");
				this.reviews.configureScope(`[User request and lead direction]\n${this.currentScope()}`, this.state.attachments);
				const seenImages = new Set(imageContent(this.state.writer.messages).map(fingerprint));
				const attachments = this.state.attachments.filter(image => !seenImages.has(fingerprint(image)));
				this.state.writer.messages.push({ role: "user", timestamp: Date.now(), content: attachments.length ? [{ type: "text", text: this.state.brief }, ...attachments] : this.state.brief });
				this.state.owner = "writer";
				this.state.active = "writer";
				this.reviews.prime(this.state.revision, `[Pre-execution context]\nThe writer has only just received this task. Unchanged files and missing verification are not defects at this stage.\n[User request]\n${this.state.task}\n[Delegation]\n${this.state.brief}`, this.state.attachments);
				result = `Delegated phase ${delegated.phase.id}, attempt ${delegated.phase.attempt}${delegated.phase.correction ? " (corrective)" : ""}. Its normal Pi tool calls follow; no editing subprocess or worktree was created.`;
				break;
			}
			case "assess": {
				if (this.state.owner === "writer") throw new Error("The writer retains its lease; update its steering or take over before assessing the attempt");
				this.state.phase = assessPhase(this.state.phase, input);
				result = phaseSummary(this.state.phase);
				break;
			}
			case "update": {
				if (this.state.owner !== "writer") throw new Error("No active writer lease is available for an update");
				if (!input.message?.trim()) throw new Error("Writer update message is required");
				const update = `[Lead update after user steering]\n${input.message.trim()}`;
				this.state.phase ??= adoptLegacyPhase(this.state.brief || this.state.task);
				this.state.phase = recordPhaseUpdate(this.state.phase, input.message);
				this.removeNotes("lead", "[Harness user steering requires lead assessment");
				const seenImages = new Set(imageContent(this.state.writer.messages).map(fingerprint));
				const attachments = this.state.attachments.filter(image => !seenImages.has(fingerprint(image)));
				this.state.writer.messages.push({ role: "user", timestamp: Date.now(), content: attachments.length ? [{ type: "text", text: update }, ...attachments] : update });
				this.reviews.configureScope(`[User request and lead direction]\n${this.currentScope()}`, this.state.attachments);
				this.reviews.prime(this.state.revision, update, attachments);
				this.state.active = "writer";
				result = "Lead update delivered to the existing writer context; the writer lease and phase were preserved.";
				break;
			}
			case "report": {
				if (!input.report?.trim()) throw new Error("Writer report is required");
				const evidence = this.handoffEvidence();
				const review = await this.reviewCheckpoint("writer-report", this.state.revision, `${this.currentScope()}\n${evidence}\nWriter completion report:\n${input.report}`, signal, undefined, true);
				current();
				this.state.reviewSummary = this.reviewSummary(review);
				const serious = review.findings.filter(finding => finding.severity !== "nit");
				if (serious.length && !review.warnings.length) {
					this.state.writerReportRejections = (this.state.writerReportRejections ?? 0) + 1;
					if (this.state.writerReportRejections >= 3) {
						this.reviews.markAlerted(review.findings);
						this.recordCoordination("lead-checkpoint", this.state.reviewers[0]?.sequence);
						this.removeNotes("lead", "[Harness writer-progress checkpoint", "[Writer completion requires lead assessment");
						this.note("lead", `[Writer completion requires lead assessment, execution revision ${this.state.revision}]\n${input.report}\n\n${evidence}\n\n${this.state.reviewSummary}\n\nThe harness paused the writer after three rejected completion reports in this delegation. Assess this writer attempt with evidence. Prefer takeover if the same defects have repeated; any further delegation must pass the phase correction gate.`);
						this.state.active = "lead";
						this.state.owner = undefined;
						result = `Harness transferred the third rejected completion report to the lead.\n${this.state.reviewSummary}`;
					} else {
						this.recordCoordination("feedback-delivered", this.state.reviewers[0]?.sequence);
						this.replaceNote("writer", "[Harness rejected the completion report", `[Harness rejected the completion report at execution revision ${this.state.revision}]\n${this.state.reviewSummary}\nCorrect supported findings and obtain a later recheck before reporting completion again. The lead has not been interrupted.`);
						this.resetWriterWindow(false);
						result = `Completion report withheld; the writer remains active to address independent review.\n${this.state.reviewSummary}`;
					}
				} else {
					this.reviews.markAlerted(review.findings);
					this.removeNotes("lead", "[Harness writer-progress checkpoint", "[Writer completion report");
					this.note("lead", `[Writer completion report, execution revision ${this.state.revision}]\n${input.report}\n\n${evidence}\n\n${this.state.reviewSummary}\n\nThe harness accepted this lead checkpoint, not phase completion. Assess the attempt with phaseId and evidence before another delegation; do not repeat specific non-conflicting reviewer reads.`);
					this.state.active = "lead";
					this.state.owner = undefined;
					result = `Harness transferred the completed writer phase to the lead${review.warnings.length ? " with incomplete-review warnings" : ""}.\n${this.state.reviewSummary}`;
				}
				break;
			}
			case "escalate": {
				if (!input.report?.trim()) throw new Error("Writer escalation is required");
				const evidence = this.handoffEvidence();
				const review = await this.reviewCheckpoint("writer-escalation", this.state.revision, `${this.currentScope()}\n${evidence}\nWriter escalation:\n${input.report}`, signal);
				current();
				this.recordCoordination("writer-escalation");
				this.state.reviewSummary = this.reviewSummary(review);
				this.reviews.markAlerted(review.findings);
				this.removeNotes("lead", "[Harness writer-progress checkpoint", "[Writer escalation");
				this.note("lead", `[Writer escalation, execution revision ${this.state.revision}]\n${input.report}\n\n${evidence}\n\n${this.state.reviewSummary}\n\nThe harness transferred this unresolved decision to the lead. Assess the attempt and record a concrete blocker if work cannot proceed; do not reset the phase by renaming it.`);
				this.state.active = "lead";
				this.state.owner = undefined;
				result = `Harness transferred the writer escalation to the lead.\n${this.state.reviewSummary}`;
				break;
			}
			case "pause": {
				this.state.active = "lead";
				const jobs = this.jobs();
				if (jobs.available && !jobs.error && !jobs.jobs.some(job => job.status === "running")) this.state.owner = undefined;
				this.note("lead", `[Writer paused for assessment at a completed tool boundary]\n${input.report}\nThe writer model is paused. Any running writer job keeps its lease. Inspect or explicitly stop its tracked job before another delegation, takeover, or final answer. Once the lease is reconciled, assess the attempt with evidence before requesting an eligible correction, or take over.`);
				result = `Writer paused; the lead will assess the confirmed review. Writer lease: ${this.state.owner ?? "none"}.`;
				break;
			}
			case "takeover":
				if (this.state.delegations === 0 && !this.state.phase) throw new Error("The lead must initiate a writer phase before taking over");
				this.state.immediateAction = undefined;
				this.state.owner = "lead";
				result = "Lead took the writer lease. The sidekick is not executing. Native mutation and shell tools are now available to the lead.";
				break;
			case "checkpoint": {
				const pending = this.state.final!;
				const review = await this.reviewCheckpoint("final-answer", this.state.revision, `${this.currentScope()}\n\nLead final-answer candidate:\n${text(pending.message)}`, signal, this.state.attachments, true);
				current();
				this.state.reviewSummary = this.reviewSummary(review);
				this.reviews.markAlerted(review.findings);
				const serious = review.findings.filter(finding => finding.severity !== "nit");
				if (serious.length && this.state.finalCorrections < MAX_FINAL_CORRECTIONS_PER_REVISION) {
					this.state.finalCorrections++;
					this.state.receipts.find(receipt => receipt.id === pending.receipt)!.delivery = "nested";
					this.state.final = undefined;
					this.replaceNote("lead", "[Final candidate withheld", `[Final candidate withheld, assessment ${this.state.finalCorrections}]\n${this.state.reviewSummary}\nAssess these findings against the recorded phase. Any writer continuation requires an assessed eligible attempt; do not reset a stalled phase. Take over if needed, or explain your disagreement and remaining uncertainty in a revised final answer.`);
					result = `Final candidate withheld for lead assessment.\n${this.state.reviewSummary}`;
				} else {
					pending.ready = true;
					this.state.receipts.find(receipt => receipt.id === pending.receipt)!.delivery = "nested";
					if (review.warnings.length || serious.length || this.state.warning) {
						this.state.warning = [this.state.warning, this.state.reviewSummary].filter(Boolean).join("\n");
						pending.message.content.push({ type: "text", text: `\n\n${this.state.warning}` });
					}
					result = `Final review complete${serious.length ? " with unresolved findings after repeated same-revision reassessment" : review.warnings.length ? " with incomplete-review warnings" : ""}.\n${this.state.reviewSummary}`;
				}
				break;
			}
			default: throw new Error(`Unknown Mixture control: ${input.action}`);
		}
		this.changed();
		const usage = this.takeUsage();
		const findings = this.reviews.findings;
		return { content: [{ type: "text" as const, text: result }], details: { action: input.action, actor: this.active, revision: this.state.revision, mixtureReceiptIds: this.lastDrained,
			controlSummary: { phaseId: this.state.phase?.id, attempt: this.state.phase?.attempt, findings: { total: findings.length, serious: findings.filter(finding => finding.severity !== "nit").length }, usage: { tokens: this.usage.totalTokens, costUsd: this.usage.cost.total } },
			performanceStats: this.performanceStats() }, usage };
	}

	completeTurn(results: ToolResultMessage[], message?: AssistantMessage) {
		const writerBatch = results.some(result => this.state.origins[result.toolCallId]?.actor === "writer" && result.toolName !== CONTROL);
		const effectfulWriterBatch = results.some(result => this.state.origins[result.toolCallId]?.actor === "writer" && result.toolName !== CONTROL && !CHECKOUT_NEUTRAL_TOOLS.has(result.toolName));
		const leadTakeoverBatch = this.state.owner === "lead" && results.some(result => this.state.origins[result.toolCallId]?.actor === "lead" && result.toolName !== CONTROL && !CHECKOUT_NEUTRAL_TOOLS.has(result.toolName));
		for (const result of results) {
			const origin = this.state.origins[result.toolCallId];
			if (!origin) continue;
			if (!origin.synthetic) this.state[origin.actor].messages.push(structuredClone(result));
			else if (result.isError) this.note(origin.actor, `[Mixture control failed] ${JSON.stringify(result.content)}. Reconcile this failure before continuing; do not blindly repeat it.`);
			const job = result.details?.job;
			if (job?.id && job.status === "running") this.state.jobs[job.id] = origin.actor;
			if (result.toolName !== CONTROL && !CHECKOUT_NEUTRAL_TOOLS.has(result.toolName)) {
				this.state.revision++;
				this.state.finalCorrections = 0;
			}
			delete this.state.origins[result.toolCallId];
		}
		if (message && !this.signal.aborted && !this.requestOptions.signal?.aborted && results.some(result => result.toolName !== CONTROL)) {
			const delta = executionDelta(message, results, this.state.revision);
			if (writerBatch) {
				if (effectfulWriterBatch) this.state.writerBatches = (this.state.writerBatches ?? 0) + 1;
				const progress = this.state.writerProgress ??= [];
				progress.push(executionProgress(message, results, this.state.revision));
				while (progress.length > 1 && progress.reduce((length, item) => length + item.length, 0) > 24_000) progress.shift();
				if (effectfulWriterBatch && this.state.reviewers.length && this.state.writerBatches % this.preset.limits.reviewEveryBatches === 0) {
					const sequence = this.reviews.enqueue(this.state.revision, delta, imageContent(results));
					(this.state.writerReviewSequences ??= []).push(sequence);
					this.recordCoordination("review-scheduled", sequence);
				} else this.reviews.prime(this.state.revision, delta, imageContent(results));
			} else if (leadTakeoverBatch && this.state.reviewers.length) {
				const sequence = this.reviews.enqueue(this.state.revision, delta, imageContent(results));
				this.recordCoordination("review-scheduled", sequence);
			} else this.reviews.prime(this.state.revision, delta, imageContent(results));
		}
		this.changed();
	}
	takeUsage() {
		this.lastDrained = this.state.receipts.filter(receipt => receipt.delivery === "nested").map(receipt => receipt.id);
		return drainReceipts(this.state.receipts);
	}
}
