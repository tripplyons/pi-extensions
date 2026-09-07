import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SEPARATOR = " | ";
const WORKING_MARKER = "[*]";

const formatTokens = (count: number) => {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

const plainStatus = (status: string | undefined) => status?.replace(ANSI_ESCAPE, "").trim() ?? "";

const statusIsOn = (statuses: ReadonlyMap<string, string>, key: string) =>
	plainStatus(statuses.get(key)).endsWith(" on");

const todoStatus = (statuses: ReadonlyMap<string, string>) => {
	const status = plainStatus(statuses.get("todo"));
	if (!status || status === "todo none") return undefined;
	return status;
};

export default function cleanFooterExtension(pi: ExtensionAPI) {
	let working = false;
	let maxCost = 0;
	let requestFooterRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		maxCost = 0;
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;

			return {
				dispose() {
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number) {
					const statuses = footerData.getExtensionStatuses();
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = context?.tokens !== null && context?.tokens !== undefined && contextWindow > 0
						? context.tokens / contextWindow * 100
						: context?.percent;
					const contextPercent = percent === null || percent === undefined
						? "?"
						: percent.toFixed(1);
					const contextUsage = `${contextPercent === "?" ? "?" : `${contextPercent}%`}/${formatTokens(contextWindow)}`;

					let cost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const entryCost = (entry.message as AssistantMessage).usage.cost.total;
						if (Number.isFinite(entryCost)) cost += Math.max(0, entryCost);
					}
					maxCost = Math.max(maxCost, cost);

					const folder = basename(ctx.cwd) || ctx.cwd;
					const workingStatus = working ? `${theme.fg("accent", theme.bold(WORKING_MARKER))} ` : "";
					const folderStatus = workingStatus + theme.fg("accent", theme.bold(folder));
					const parts = [
						folderStatus,
						theme.fg("muted", ctx.model?.id ?? "no-model"),
						theme.fg("muted", pi.getThinkingLevel()),
						theme.fg("muted", contextUsage),
						theme.fg("muted", `$${maxCost.toFixed(2)}`),
					];
					if (statusIsOn(statuses, "local")) parts.push(theme.fg("muted", "local"));
					if (statusIsOn(statuses, "codex-fast-mode")) parts.push(theme.fg("muted", "fast"));
					if (statusIsOn(statuses, "goal")) parts.push(theme.fg("muted", "goal"));
					if (statusIsOn(statuses, "context-compression")) parts.push(theme.fg("muted", "compression"));
					if (statusIsOn(statuses, "review")) parts.push(theme.fg("muted", "review"));
					const todo = todoStatus(statuses);
					if (todo) parts.push(theme.fg("muted", todo));

					return [truncateToWidth(parts.join(theme.fg("dim", SEPARATOR)), width)];
				},
			};
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		working = true;
		requestFooterRender?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		working = false;
		requestFooterRender?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		working = false;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
	});
}
