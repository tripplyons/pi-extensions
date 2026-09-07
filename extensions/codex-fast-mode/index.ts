import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "codex-fast-mode-state";
const SWARM_FAST_MODE_ENV = "PI_SWARM_CODEX_FAST_MODE";

type StoredEntry = {
	type?: string;
	customType?: string;
	data?: { enabled?: unknown };
};

type PreviousSelection = {
	model: NonNullable<ExtensionContext["model"]>;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	fastModeEnabled: boolean;
};

const readStoredEnabled = (entries: StoredEntry[]) => {
	let enabled: boolean | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		if (typeof entry.data?.enabled === "boolean") enabled = entry.data.enabled;
	}
	return enabled;
};

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let previousSelection: PreviousSelection | undefined;

	const persistEnabled = () => {
		pi.appendEntry(CUSTOM_TYPE, { enabled });
	};

	const setStatus = (ctx: ExtensionContext) => {
		const value = enabled ? "on" : "off";
		ctx.ui.setStatus("codex-fast-mode", ctx.ui.theme.fg("dim", "fast ") + ctx.ui.theme.fg("accent", value));
	};

	pi.on("session_start", async (_event, ctx) => {
		const storedEnabled = readStoredEnabled(ctx.sessionManager.getEntries() as StoredEntry[]);
		enabled = storedEnabled ?? process.env[SWARM_FAST_MODE_ENV] === "on";
		setStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || ctx.model?.provider !== "openai-codex") {
			return undefined;
		}

		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return undefined;
		}

		return {
			...(payload as Record<string, unknown>),
			service_tier: "priority",
		};
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex priority service tier for this session (on, off, toggle)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action === "" || action === "toggle") enabled = !enabled;
			else {
				ctx.ui.notify("Usage: /fast [on|off|toggle]", "warning");
				return;
			}

			persistEnabled();
			setStatus(ctx);
			ctx.ui.notify(`Codex fast mode ${enabled ? "on" : "off"} for this session`, "info");
		},
	});

	pi.registerShortcut("ctrl+f", {
		description: "Toggle GPT-5.6 Luna high with Codex fast mode",
		handler: async (ctx) => {
			if (previousSelection) {
				const restored = await pi.setModel(previousSelection.model);
				if (!restored) {
					ctx.ui.notify("Could not restore the previous model: authentication unavailable", "error");
					return;
				}

				pi.setThinkingLevel(previousSelection.thinkingLevel);
				enabled = previousSelection.fastModeEnabled;
				previousSelection = undefined;
				persistEnabled();
				setStatus(ctx);
				ctx.ui.notify("Restored previous model settings", "info");
				return;
			}

			const model = ctx.modelRegistry.find("openai-codex", "gpt-5.6-luna");
			if (!model || !ctx.model) {
				ctx.ui.notify("GPT-5.6 Luna is unavailable", "error");
				return;
			}

			const selection = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				fastModeEnabled: enabled,
			};
			if (!(await pi.setModel(model))) {
				ctx.ui.notify("Could not select GPT-5.6 Luna: authentication unavailable", "error");
				return;
			}

			previousSelection = selection;
			pi.setThinkingLevel("high");
			enabled = true;
			persistEnabled();
			setStatus(ctx);
			ctx.ui.notify("GPT-5.6 Luna high with Codex fast mode", "info");
		},
	});
}
