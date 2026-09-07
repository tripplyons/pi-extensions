import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMPUTER_USE_TOOL_NAMES = ["computer_use"] as const;

const COMPUTER_USE_TOOLS = new Set<string>(COMPUTER_USE_TOOL_NAMES);

export default function computerUseToggle(pi: ExtensionAPI) {
	let enabled = false;

	const disableTools = () => {
		const activeTools = pi.getActiveTools();
		const nextActive = activeTools.filter((name) => !COMPUTER_USE_TOOLS.has(name));
		if (nextActive.length !== activeTools.length) pi.setActiveTools(nextActive);
	};

	const enableTools = (ctx: ExtensionContext): boolean => {
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const missingTools = COMPUTER_USE_TOOL_NAMES.filter((name) => !availableTools.has(name));
		if (missingTools.length > 0) {
			ctx.ui.notify(`Computer Use unavailable: missing ${missingTools.join(", ")}`, "error");
			return false;
		}
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...COMPUTER_USE_TOOL_NAMES])]);
		enabled = true;
		return true;
	};

	const reset = () => {
		enabled = false;
		disableTools();
	};

	pi.on("session_start", reset);
	pi.on("resources_discover", reset);
	pi.on("before_agent_start", () => {
		if (!enabled) disableTools();
	});

	pi.registerCommand("computer-use", {
		description: "Toggle Computer Use for the current session (on, off, status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /computer-use [on|off|status]", "warning");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(`Computer Use is ${enabled ? "on" : "off"} for this session.`, "info");
				return;
			}

			const shouldEnable = action === "on" || (action === "" && !enabled);
			if (shouldEnable) {
				if (enabled) {
					ctx.ui.notify("Computer Use is already on for this session.", "info");
					return;
				}
				if (enableTools(ctx)) ctx.ui.notify("Computer Use enabled for this session.", "info");
				return;
			}

			disableTools();
			enabled = false;
			ctx.ui.notify("Computer Use disabled for this session.", "info");
		},
	});
}
