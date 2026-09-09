import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fetchCodexUsage } from "@howaboua/pi-codex-conversion/dist/codex-usage/client.js";
import { formatCodexUsage } from "@howaboua/pi-codex-conversion/dist/codex-usage/format.js";

const DISMISS_KEYS = new Set(["\x1b", "q", "\r", "\n", " "]);

function usageOverlay(text: string, done: () => void) {
	const content = new Text(`${text}\n\nEsc/q/Enter/Space to close`, 1, 1);
	return {
		render: (width: number) => content.render(width),
		invalidate: () => content.invalidate(),
		handleInput(data: string) {
			if (DISMISS_KEYS.has(data)) done();
		},
	};
}

async function showUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const usage = formatCodexUsage(await fetchCodexUsage({ ...ctx, signal }));
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(usage, "info");
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, done) => usageOverlay(usage, done),
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

	pi.registerCommand("usage", {
		description: "Show current Codex usage limits",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify("Codex usage is only available when an OpenAI Codex model is selected.", "warning");
				return;
			}

			active?.abort();
			const controller = new AbortController();
			active = controller;
			try {
				await showUsage(ctx, controller.signal);
			} catch (error) {
				if (active === controller && !controller.signal.aborted) {
					ctx.ui.notify(error instanceof Error ? error.message : "Unable to load Codex usage.", "error");
				}
			} finally {
				if (active === controller) active = undefined;
			}
		},
	});
}
