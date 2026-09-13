import { basename } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SEPARATOR = " | ";
const WORKING_MARKER = "[*]";
const HIDDEN_STATUS_KEY = "codex-adapter";

const formatTokens = (count: number) => {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
};

const plainStatus = (status: string | undefined) => status?.replace(ANSI_ESCAPE, "").trim() ?? "";

export function sessionCost(entries: readonly SessionEntry[]): number {
	let cost = 0;
	for (const entry of entries) {
		const usage = entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
			: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage : undefined;
		const value = usage?.cost.total;
		if (value !== undefined && Number.isFinite(value)) cost += Math.max(0, value);
	}
	return cost;
}

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

					maxCost = Math.max(maxCost, sessionCost(ctx.sessionManager.getEntries()));

					const folder = basename(ctx.cwd) || ctx.cwd;
					const workingStatus = working ? `${theme.fg("accent", theme.bold(WORKING_MARKER))} ` : "";
					const folderStatus = workingStatus + theme.fg("accent", theme.bold(folder));
					const parts = [
						folderStatus,
						theme.fg("muted", ctx.model?.provider === "mixture" ? `mixture/${ctx.model.id}` : ctx.model?.id ?? "no-model"),
						theme.fg("muted", pi.getThinkingLevel()),
						theme.fg("muted", contextUsage),
						theme.fg("muted", `$${maxCost.toFixed(2)}`),
					];
					const statusParts: string[] = [];
					for (const [key, value] of statuses) {
						if (key === HIDDEN_STATUS_KEY) continue;
						const status = plainStatus(value);
						if (status) statusParts.push(theme.fg("muted", status));
					}

					const separator = theme.fg("dim", SEPARATOR);
					const combined = [...parts, ...statusParts].join(separator);
					if (ctx.model?.provider === "mixture" && statusParts.length && visibleWidth(combined) > width) {
						return [truncateToWidth(parts.join(separator), width), truncateToWidth(statusParts.join(separator), width)];
					}
					return [truncateToWidth(combined, width)];
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
