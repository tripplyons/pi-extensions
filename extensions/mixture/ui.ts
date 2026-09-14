import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSelectListTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig, parseConfig, type MixtureConfig, type RoleConfig } from "./config.ts";
import { validatePreset } from "./provider.ts";
import { phaseSummary } from "./phase.ts";
import type { MixtureSession } from "./session.ts";

const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function compactStatus(session: MixtureSession, compacting = false): string {
	const activity = compacting ? "compacting" : session.activity;
	const actor = activity === "reviewing" ? "reviewer" : session.active;
	return `${actor} · ${activity} · $${session.usage.cost.total.toFixed(3)}`;
}
export function inspection(session: MixtureSession): string {
	const { state, preset } = session;
	const roles = [["Lead", preset.lead, state.lead, "lead"], ["Writer", preset.writer.model, state.writer, "writer"], ...state.reviewers.map((reviewer, index) => [`Reviewer ${index + 1}`, preset.reviewers[index].model, reviewer, `reviewer-${index + 1}`] as const)] as const;
	const timings = session.performanceStats();
	const lines = [`Mixture ${state.preset}`, `Active: ${state.active}; writer lease: ${state.owner ?? "none"}; execution revision: ${state.revision}`, ""];
	for (const [name, model, role, timingKey] of roles) {
		const timing = timings.requests[timingKey];
		const latency = timing ? `; latency avg ${Math.round(timing.totalMs / timing.count)}ms, max ${Math.round(timing.maxMs)}ms` : "";
		lines.push(`${name}: ${model}`, `  ${role.calls} requests; ${role.usage.totalTokens} tokens; $${role.usage.cost.total.toFixed(4)}; context ~${role.contextTokens ?? "?"}; summaries ${role.summaries ?? 0}${latency}`);
	}
	for (const [name, timing] of Object.entries(timings.checkpoints)) lines.push(`Review ${name}: ${timing.count} waits; avg ${Math.round(timing.totalMs / timing.count)}ms; max ${Math.round(timing.maxMs)}ms`);
	const coordination = state.coordination;
	lines.push("", `Total reported cost: $${session.usage.cost.total.toFixed(4)}; queued reviews: ${session.reviews.backlog}`,
		`Delegations: ${state.delegations}; writer responses: ${state.writerTurns}/${preset.limits.writerTurns}; transient retries: ${state.writerRetries ?? 0}; rejected reports: ${state.writerReportRejections ?? 0}; current tool batches: ${state.writerBatches ?? 0}; final assessments: ${state.finalCorrections}`,
		`Harness totals: ${coordination?.scheduledReviews ?? 0} reviews scheduled; ${coordination?.deliveredReviews ?? 0} delivered to writer; ${coordination?.leadCheckpoints ?? 0} forced lead checkpoints; ${coordination?.escalations ?? 0} early escalations`);
	for (const [index, reviewer] of state.reviewers.entries()) {
		lines.push(`Reviewer ${index + 1}: ${reviewer.status}; revision ${reviewer.revision}; ${reviewer.requestCalls} requests this task`);
		if (reviewer.warning) lines.push(`  Incomplete review: ${reviewer.warning}`);
		if (reviewer.imageWarning) lines.push(`  ${reviewer.imageWarning}`);
		for (const finding of reviewer.findings) lines.push(`  [${finding.severity}] ${finding.id}, revision ${finding.revision}: ${finding.summary}${finding.path ? ` (${finding.path})` : ""}${finding.evidence ? `\n    ${finding.evidence}` : ""}`);
	}
	if (state.phase) lines.push("", phaseSummary(state.phase, false));
	if (state.task) lines.push("", `User request: ${state.task}`);
	if (state.brief) lines.push("", state.brief);
	if (state.warning) lines.push("", state.warning);
	return clean(lines.join("\n"));
}
export function controlCard(content: string, expanded: boolean, theme: Theme) {
	const body = clean(content);
	const text = new Text(expanded ? body : theme.fg("muted", body.split("\n")[0]), 0, 0);
	return { invalidate() { text.invalidate(); }, render(width: number) {
		return expanded ? text.render(width) : [truncateToWidth(text.render(Math.max(width, 1))[0] ?? "", width)];
	} };
}
export class Inspector {
	private offset = 0;
	private total = 0;
	constructor(private text: string, private height: () => number, private renderAgain: () => void, private done: () => void, private theme?: Theme) {}
	invalidate() {}
	handleInput(input: string) {
		if (matchesKey(input, Key.escape) || matchesKey(input, Key.enter)) { this.done(); return; }
		const page = Math.max(1, this.height() - 4);
		if (matchesKey(input, Key.down)) this.offset++;
		if (matchesKey(input, Key.up)) this.offset--;
		if (matchesKey(input, Key.pageDown)) this.offset += page;
		if (matchesKey(input, Key.pageUp)) this.offset -= page;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.total - page)));
		this.renderAgain();
	}
	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const lines = new Text(clean(this.text), 0, 0).render(inner);
		this.total = lines.length;
		const height = Math.max(1, this.height() - 4);
		this.offset = Math.min(this.offset, Math.max(0, lines.length - height));
		const color = (value: string) => this.theme?.fg("accent", value) ?? value;
		const row = (line: string) => `${color("│")} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${color("│")}`;
		const rule = (left: string, right: string) => color(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
		return [rule("╭", "╮"), ...lines.slice(this.offset, this.offset + height).map(row), rule("├", "┤"), row(truncateToWidth("↑↓/PgUp/PgDn scroll · Enter/Esc close", inner)), rule("╰", "╯")];
	}
}

export async function configure(ctx: ExtensionCommandContext, current: MixtureConfig | undefined, requestedName?: string): Promise<MixtureConfig | undefined> {
	if (!ctx.hasUI) throw new Error("/mixture configure needs an interactive Pi UI; edit mixture.json directly in print mode");
	if (!ctx.isIdle()) throw new Error("Mixture configuration is available only while idle; finish or cancel the current task first");
	const candidate = structuredClone(current ?? defaultConfig());
	let name = requestedName;
	if (!name) {
		name = await ctx.ui.select("Mixture preset", [...Object.keys(candidate.presets), "New preset…"]);
		if (name === "New preset…") name = await ctx.ui.input("Preset name", "default");
	}
	if (!name) return;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) throw new Error(`Invalid preset name: ${name}`);
	const preset = candidate.presets[name] ?? structuredClone(defaultConfig().presets.default);
	const available = ctx.modelRegistry.getAvailable().filter(model => model.provider !== "mixture");
	if (!available.length) throw new Error("No authenticated role models are available. Configure Pi provider credentials first.");
	const chooseModel = async (label: string, current: string) => {
		const ids = available.map(model => `${model.provider}/${model.id}`);
		const ordered = ids.includes(current) ? [current, ...ids.filter(id => id !== current)] : ids;
		if (ctx.mode !== "tui") return ctx.ui.select(label, ordered);
		return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
			const input = new Input();
			const items = ordered.map(value => ({ value, label: value }));
			const rebuild = () => {
				const list = new SelectList(fuzzyFilter(items, input.getValue(), item => item.value), Math.max(2, Math.min(8, tui.terminal.rows - 8)), getSelectListTheme());
				list.onSelect = item => done(item.value);
				list.onCancel = () => done(undefined);
				return list;
			};
			let list = rebuild();
			return {
				get focused() { return input.focused; }, set focused(value: boolean) { input.focused = value; },
				invalidate() { input.invalidate(); list.invalidate(); },
				render(width: number) {
					const border = theme.fg("accent", "─".repeat(width));
					return [border, ...new Text(label, 0, 0).render(width), ...input.render(width), ...list.render(width), truncateToWidth("Type to filter · ↑↓ choose · Enter select · Esc cancel", width), border];
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { done(undefined); return; }
					if ([Key.up, Key.down, Key.pageUp, Key.pageDown, Key.enter].some(key => matchesKey(data, key))) list.handleInput(data);
					else { input.handleInput(data); list = rebuild(); }
					tui.requestRender();
				},
			};
		});
	};
	const chooseRole = async (label: string, role: RoleConfig): Promise<RoleConfig | undefined> => {
		const model = await chooseModel(`${label} model`, role.model);
		if (!model) return;
		const resolved = available.find(value => `${value.provider}/${value.id}` === model)!;
		const supported = getSupportedThinkingLevels(resolved);
		const levels = supported.includes(role.thinking) ? [role.thinking, ...supported.filter(level => level !== role.thinking)] : supported;
		const thinking = await ctx.ui.select(`${label} thinking`, levels);
		return thinking ? { ...role, model, thinking: thinking as ModelThinkingLevel } : undefined;
	};
	const lead = await chooseModel("Lead model (thinking follows Pi's selector)", preset.lead);
	if (!lead) return;
	const writer = await chooseRole("Writer", preset.writer);
	if (!writer) return;
	const reviewerCount = await ctx.ui.select("Independent reviewers", [String(preset.reviewers.length), ...[0, 1, 2, 3, 4].filter(count => count !== preset.reviewers.length).map(String)]);
	if (reviewerCount === undefined) return;
	const reviewers: RoleConfig[] = [];
	for (let index = 0; index < Number(reviewerCount); index++) {
		const reviewer = await chooseRole(`Reviewer ${index + 1}`, preset.reviewers[index] ?? defaultConfig().presets.default.reviewers[index % 2]);
		if (!reviewer) return;
		reviewers.push(reviewer);
	}
	candidate.presets[name] = { ...preset, lead, writer, reviewers };
	const edited = await ctx.ui.editor("Review Mixture config; edit guidance or limits if needed", JSON.stringify(candidate, null, 2));
	if (edited === undefined) return;
	const validated = parseConfig(JSON.parse(edited));
	for (const preset of Object.values(validated.presets)) validatePreset(preset, ctx.modelRegistry.find.bind(ctx.modelRegistry));
	if (!await ctx.ui.confirm("Save Mixture configuration?", `Write the reviewed proposal to the installed mixture.json?\nPresets: ${Object.keys(validated.presets).length}. No models will run.`)) return;
	if (!ctx.isIdle()) throw new Error("A task started while configuring Mixture; nothing was saved");
	return validated;
}
