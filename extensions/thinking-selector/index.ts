import { getSelectListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, Text } from "@earendil-works/pi-tui";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function supportedThinkingLevels(model: NonNullable<ExtensionContext["model"]>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

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
		const title = new Text(theme.fg("accent", "Thinking level"), 0, 0);
		const list = new SelectList(
			labels.map((value) => ({ value, label: value })),
			Math.max(1, Math.min(labels.length, tui.terminal.rows - 4)),
			getSelectListTheme(),
		);
		list.setSelectedIndex(initialIndex);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		return {
			render(width: number) {
				return [...title.render(width), ...list.render(width)];
			},
			invalidate() {
				title.invalidate();
				list.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "j")) list.handleInput("\x1b[B");
				else if (matchesKey(data, "k")) list.handleInput("\x1b[A");
				else list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "50%", anchor: "center" } });
}

export default function thinkingSelector(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+t", {
		description: "Select thinking level",
		handler: async (ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("Select a model before choosing a thinking level.", "warning");
				return;
			}

			const levels = supportedThinkingLevels(ctx.model);
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
