import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
			const selected = await ctx.ui.select("Thinking level", labels);
			const index = selected === undefined ? -1 : labels.indexOf(selected);
			if (index >= 0) pi.setThinkingLevel(levels[index]!);
		},
	});
}
