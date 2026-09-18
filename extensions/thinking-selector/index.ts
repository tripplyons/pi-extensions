import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getSelectListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function label(level: ThinkingLevel, current: ThinkingLevel): string {
	return level === current ? `${level} (current)` : level;
}

async function selectThinkingLevel(
	ctx: ExtensionContext,
	labels: string[],
	initialIndex: number,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select("Thinking level", labels);

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const title = new Text(theme.fg("customMessageText", "Thinking level"), 0, 0);
		// Reserve a title row, Box padding, and a possible SelectList scroll indicator.
		const maxVisible = Math.max(1, Math.min(labels.length, Math.floor(tui.terminal.rows * 0.7) - 4));
		const list = new SelectList(
			labels.map((value) => ({ value, label: value })),
			maxVisible,
			getSelectListTheme(),
			{
				truncatePrimary: ({ text, isSelected }) => isSelected ? text : theme.fg("customMessageText", text),
			},
		);
		list.setSelectedIndex(initialIndex);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(title);
		box.addChild(list);
		return {
			render(width: number) {
				return box.render(width);
			},
			invalidate() {
				box.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "j")) list.handleInput("\x1b[B");
				else if (matchesKey(data, "k")) list.handleInput("\x1b[A");
				else list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" } });
}

export default function thinkingSelector(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+t", {
		description: "Select thinking level",
		handler: async (ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("Select a model before choosing a thinking level.", "warning");
				return;
			}

			const levels = getSupportedThinkingLevels(ctx.model);
			if (levels.length === 0 || (levels.length === 1 && levels[0] === "off")) {
				ctx.ui.notify("The selected model does not support thinking levels.", "warning");
				return;
			}

			const current = pi.getThinkingLevel();
			const labels = levels.map((level) => label(level, current));
			const initialIndex = Math.max(0, levels.indexOf(current));
			const selected = await selectThinkingLevel(ctx, labels, initialIndex);
			const index = selected === undefined ? -1 : labels.indexOf(selected);
			if (index >= 0) pi.setThinkingLevel(levels[index]!);
		},
	});
}
