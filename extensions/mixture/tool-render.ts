import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../agent-swarm/output-format.ts";

type Paint = Pick<Theme, "fg" | "bold">;
type Row = { text: string; color: ThemeColor };
export type Preview = { rows: Row[] };
const clean = (value: unknown, limit = 240) => sanitizeTerminalText(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, limit);
const statusColor = (status: string): ThemeColor => status === "ok" || status === "accepted" ? "success" : ["failed", "rejected", "timeout"].includes(status) ? "error" : "warning";

// Keep display metadata bounded independently of the model-facing JSON limit.
export function mixturePreview(value: any): Preview {
	const rows: Row[] = [];
	const add = (text: string, color: ThemeColor = "muted") => { if (rows.length < 100) rows.push({ text, color }); };
	const runs = Array.isArray(value) ? value : [value];
	if (!runs.length) add("No mixture runs");
	for (const run of runs.slice(0, 20)) {
		add(clean(run.id ?? run.runId), "accent");
		if (run.requestId) add(`${clean(run.status)} · request ${clean(run.requestId)}`, statusColor(run.status));
		if (run.task) add(clean(run.task));
		const workers = run.workers ?? (run.workerId ? [{ ...run, id: run.workerId }] : []);
		for (const worker of workers.slice(0, 20)) {
			const attempt = worker.attempts?.at(-1) ?? worker;
			const status = attempt.status ?? "queued";
			add(`${clean(worker.id)} · ${clean(worker.model)} · ${status} · attempt ${attempt.attempt ?? 0}`, statusColor(status));
			if (attempt.output) add(clean(attempt.output, 2000));
			if (attempt.error) add(clean(attempt.error), "error");
			if (attempt.usage) add(`${attempt.usage.turns} turns · ${attempt.usage.input} in / ${attempt.usage.output} out · $${attempt.usage.cost.toFixed(6)}`, "dim");
			if (worker.changes) add(`Changes: ${clean(worker.changes)}`);
		}
		for (const command of (run.commands ?? []).slice(-5)) add(`${clean(command.action)} · ${clean(command.status)}${command.error ? ` · ${clean(command.error)}` : ""}`, statusColor(command.status));
	}
	return { rows };
}

export function renderMixtureCall(name: string, args: any, theme: Paint) {
	return new Text(`${theme.fg("toolTitle", theme.bold(name === "mixture_run" ? "mixture run" : `mixture ${clean(args.action)}`))} ${theme.fg("muted", [args.runId, args.workerId, args.task, args.message].filter(Boolean).map((part) => clean(part, 100)).join(" · "))}`, 0, 0);
}

export function renderMixtureResult(result: { content?: any; details?: any; isError?: boolean }, options: { expanded: boolean; isPartial?: boolean }, theme: Paint) {
	let preview: Preview | undefined = result.details?.preview;
	const content = typeof result.content === "string" ? result.content : result.content?.find((part: any) => part.type === "text")?.text;
	if (!preview && content) {
		try { preview = mixturePreview(JSON.parse(content)); } catch { /* Older or truncated results retain their state-file pointer. */ }
	}
	if (!preview) return new Text(theme.fg(result.isError ? "error" : "muted", clean(content ?? (options.isPartial ? "Starting…" : "No preview available"))), 0, 0);
	const rows = options.expanded ? preview.rows : preview.rows.slice(0, 6);
	const lines = rows.map((row) => theme.fg(row.color, options.expanded ? row.text : clean(row.text, 160)));
	if (!options.expanded && preview.rows.length > 6) lines.push(theme.fg("dim", `${preview.rows.length - 6} more rows · expand for details`));
	if (options.expanded && result.details?.stateFile) lines.push(theme.fg("dim", `Full state: ${clean(result.details.stateFile, 1000)}`));
	return new Text(lines.join("\n"), 0, 0);
}
