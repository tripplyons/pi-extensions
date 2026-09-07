import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "openai-codex-usage";
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

type JsonObject = Record<string, unknown>;

type LimitWindow = {
	usedPercent: number;
	resetAt?: number;
};

type CodexUsage = {
	weekly?: LimitWindow;
};

function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseWindow(value: unknown, now: number): LimitWindow | undefined {
	const window = asObject(value);
	const usedPercent = numberValue(window?.used_percent);
	if (usedPercent === undefined) return undefined;

	const resetAtSeconds = numberValue(window?.reset_at);
	const resetAfterSeconds = numberValue(window?.reset_after_seconds);
	const resetAt = resetAtSeconds !== undefined
		? resetAtSeconds * 1000
		: resetAfterSeconds !== undefined
			? now + resetAfterSeconds * 1000
			: undefined;

	return {
		usedPercent: clampPercent(usedPercent),
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function usageFromApi(payload: unknown, now = Date.now()): CodexUsage | undefined {
	const rateLimit = asObject(asObject(payload)?.rate_limit);
	const weekly = parseWindow(rateLimit?.primary_window, now);
	return weekly ? { weekly } : undefined;
}

function decodeBase64Url(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return atob(padded);
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = asObject(JSON.parse(decodeBase64Url(payload)));
		const accountId = asObject(claims?.[ACCOUNT_ID_CLAIM])?.chatgpt_account_id;
		return typeof accountId === "string" ? accountId : undefined;
	} catch {
		return undefined;
	}
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) return undefined;
		return response.json();
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<CodexUsage | undefined> {
	if (!ctx.model || ctx.model.provider !== "openai-codex") return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) return undefined;

	const accountId = accountIdFromToken(auth.apiKey);
	const payload = await fetchJsonWithTimeout(USAGE_ENDPOINT, {
		headers: {
			authorization: `Bearer ${auth.apiKey}`,
			...(accountId ? { "chatgpt-account-id": accountId } : {}),
			accept: "application/json",
			"user-agent": "pi-openai-codex-usage-extension",
		},
	});

	return usageFromApi(payload);
}

function remainingPercent(window: LimitWindow): number {
	return clampPercent(100 - window.usedPercent);
}

function formatRemaining(window: LimitWindow | undefined): string {
	if (!window) return "--";
	return `${remainingPercent(window).toFixed(0)}%`;
}

function formatDuration(milliseconds: number): string {
	let minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
	if (minutes === 0) return "now";

	const days = Math.floor(minutes / (24 * 60));
	minutes -= days * 24 * 60;
	const hours = Math.floor(minutes / 60);
	minutes -= hours * 60;

	return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean).join(" ");
}

function formatWindow(label: string, window: LimitWindow | undefined, now: number): string {
	if (!window) return `${label}  unavailable`;

	const usage = `${remainingPercent(window).toFixed(0)}% remaining`;
	if (window.resetAt === undefined) return `${label}  ${usage} · reset time unavailable`;
	return `${label}  ${usage} · ends in ${formatDuration(window.resetAt - now)}`;
}

function formatUsage(usage: CodexUsage, now = Date.now()): string {
	return `Codex usage\n${formatWindow("1w", usage.weekly, now)}`;
}

function statusText(ctx: ExtensionContext, usage: CodexUsage | undefined): string {
	const weeklyLabel = ctx.ui.theme.fg("muted", "1w");
	const weekly = ctx.ui.theme.fg("accent", formatRemaining(usage?.weekly));
	return ctx.ui.theme.fg("dim", "codex ") + `${weeklyLabel} ${weekly}`;
}

function updateStatus(ctx: ExtensionContext, usage: CodexUsage | undefined) {
	if (ctx.model?.provider !== "openai-codex") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, statusText(ctx, usage));
}

export default function (pi: ExtensionAPI) {
	let latestUsage: CodexUsage | undefined;
	let refreshId = 0;

	function refreshUsage(ctx: ExtensionContext) {
		const id = ++refreshId;
		void fetchCodexUsage(ctx)
			.then((usage) => {
				if (id !== refreshId) return;
				if (usage) latestUsage = usage;
				updateStatus(ctx, latestUsage);
			})
			.catch(() => {
				if (id === refreshId) updateStatus(ctx, latestUsage);
			});
	}

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx, latestUsage);
		refreshUsage(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx, latestUsage);
		refreshUsage(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") refreshUsage(ctx);
	});

	pi.registerCommand("usage", {
		description: "Show Codex weekly usage window",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify("Codex usage is only available when an OpenAI Codex model is selected.", "warning");
				return;
			}

			try {
				const usage = await fetchCodexUsage(ctx);
				if (!usage) {
					ctx.ui.notify("Unable to load Codex usage.", "error");
					return;
				}

				latestUsage = usage;
				updateStatus(ctx, usage);
				ctx.ui.notify(formatUsage(usage), "info");
			} catch {
				ctx.ui.notify("Unable to load Codex usage.", "error");
			}
		},
	});
}
