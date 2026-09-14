import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { fetchCodexUsage } from "@howaboua/pi-codex-conversion/dist/codex-usage/client.js";

type CodexUsageSnapshot = Awaited<ReturnType<typeof fetchCodexUsage>>;
type CodexUsageWindow = NonNullable<CodexUsageSnapshot["limits"][number]["primary"]>;

const CODEX_USAGE_MODEL = "gpt-5.6-luna";
const CODEX_AUTH_ERROR = "Canonical OpenAI Codex subscription auth is required.";
const DISMISS_KEYS = new Set(["\x1b", "q", "\r", "\n", " "]);

function formatReset(timestampSeconds: number | undefined): string {
	if (!timestampSeconds) return "reset unknown";
	const minutes = Math.max(0, Math.round((timestampSeconds * 1000 - Date.now()) / 60000));
	return minutes < 90 ? `resets in ~${minutes}m` : `resets ${new Date(timestampSeconds * 1000).toLocaleString()}`;
}

function formatWindow(label: string, window: CodexUsageWindow | undefined): string {
	if (!window) return `${label}: unavailable`;
	const remaining = window.usedPercent === undefined
		? "?"
		: `${Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)))}%`;
	return `${label}: ${remaining} left · ${formatReset(window.resetsAt)}`;
}

function formatCodexUsage(snapshot: CodexUsageSnapshot): string {
	const standard = snapshot.limits.find(({ limitId }) => limitId.toLowerCase() === "codex");
	return [
		"Codex usage",
		formatWindow("5h", standard?.primary),
		formatWindow("weekly", standard?.secondary),
	].join("\n");
}

function usageContext(ctx: ExtensionContext, signal: AbortSignal): ExtensionContext {
	const model = ctx.modelRegistry.find("openai-codex", CODEX_USAGE_MODEL);
	if (!model) throw new Error("Canonical OpenAI Codex model is unavailable.");
	return { ...ctx, model, signal };
}

function usageOverlay(text: string, done: () => void, theme: Theme) {
	const content = new Text(theme.fg("customMessageText", `${text}\n\nEsc/q/Enter/Space to close`), 0, 0);
	const box = new Box(1, 1, value => theme.bg("customMessageBg", value));
	box.addChild(content);
	return {
		render: (width: number) => box.render(width),
		invalidate: () => box.invalidate(),
		handleInput(data: string) {
			if (DISMISS_KEYS.has(data)) done();
		},
	};
}

async function showUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const usage = formatCodexUsage(await fetchCodexUsage(usageContext(ctx, signal)));
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(usage, "info");
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => usageOverlay(usage, done, theme),
		{
			overlay: true,
			overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" },
		},
	);
}

export default function usageExtension(pi: ExtensionAPI): void {
	let active: AbortController | undefined;

	pi.on("session_shutdown", async () => {
		active?.abort();
		active = undefined;
	});

	pi.registerCommand("codex-usage", {
		description: "Show current Codex usage limits",
		handler: async (_args, ctx) => {
			active?.abort();
			const controller = new AbortController();
			active = controller;
			try {
				await showUsage(ctx, controller.signal);
			} catch (error) {
				if (active === controller && !controller.signal.aborted) {
					ctx.ui.notify(error instanceof Error ? error.message : CODEX_AUTH_ERROR, "error");
				}
			} finally {
				if (active === controller) active = undefined;
			}
		},
	});
}
