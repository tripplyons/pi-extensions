import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type TruncationResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withStatusCard } from "../tool-status-style/style.ts";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "web-search-and-extract");
const COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_EXTRACT_TIMEOUT_SECONDS = 10;
const CODEX_PROVIDER = "openai-codex";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const CODEX_SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const CODEX_REQUEST_ID_PREFIX = "pi-web";
const CODEX_MAX_OUTPUT_TOKENS = 6000;
const CODEX_USER_AGENT = "pi-web-search-and-extract-extension";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";
const LOCAL_MODE_CUSTOM_TYPE = "web-search-local-mode-state";

const SearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	provider: Type.Optional(StringEnum(["auto", "codex", "ddgs"] as const)),
	maxResults: Type.Optional(Type.Integer({ description: `Maximum search results (default ${DEFAULT_MAX_RESULTS}). Codex uses this to choose response length.`, minimum: 1, maximum: 25 })),
	region: Type.Optional(Type.String({ description: "Optional DDGS region, e.g. us-en" })),
	timelimit: Type.Optional(StringEnum(["d", "w", "m", "y"] as const)),
	backend: Type.Optional(Type.String({ description: "Optional DDGS backend (default: auto)" })),
});

const ExtractParams = Type.Object({
	url: Type.String({ description: "URL to extract to markdown" }),
	provider: Type.Optional(StringEnum(["auto", "codex", "ddgs", "camoufox"] as const)),
	timeout: Type.Optional(Type.Number({ description: `Rendered-page timeout in seconds for Camoufox extraction (default ${DEFAULT_EXTRACT_TIMEOUT_SECONDS})`, minimum: 1, maximum: 60 })),
});

type SearchProvider = "auto" | "codex" | "ddgs";
type ExtractProvider = "auto" | "codex" | "ddgs" | "camoufox";
type UsedProvider = "openai-codex" | "ddgs" | "camoufox";

type ToolDetails = {
	type: "search" | "extract";
	provider?: UsedProvider;
	requestedProvider?: SearchProvider | ExtractProvider;
	args?: string[];
	stderr?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
};

type JsonObject = Record<string, unknown>;

type CodexAuth = {
	model: string;
	token: string;
	accountId?: string;
	extraHeaders?: Record<string, string>;
};

type StoredEntry = {
	type?: string;
	customType?: string;
	data?: { enabled?: unknown };
};

const parseProvider = (output: string) => output.match(/^(?:Provider|Source):\s*(.+)$/m)?.[1]?.trim() as UsedProvider | undefined;

const optionalText = (value: string | undefined) => {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
};

const asObject = (value: unknown): JsonObject | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined);
const stringValue = (value: unknown) => (typeof value === "string" ? value : undefined);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readStoredLocalMode = (entries: StoredEntry[]) => {
	let enabled = false;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === LOCAL_MODE_CUSTOM_TYPE && typeof entry.data?.enabled === "boolean") {
			enabled = entry.data.enabled;
		}
	}
	return enabled;
};

const checkedInteger = (value: number | undefined, fallback: number, name: string, min: number, max: number) => {
	const actual = value ?? fallback;
	if (!Number.isInteger(actual) || actual < min || actual > max) {
		throw new Error(`${name} must be an integer from ${min} to ${max}`);
	}
	return actual;
};

const checkedNumber = (value: number | undefined, fallback: number, name: string, min: number, max: number) => {
	const actual = value ?? fallback;
	if (!Number.isFinite(actual) || actual < min || actual > max) {
		throw new Error(`${name} must be a number from ${min} to ${max}`);
	}
	return actual;
};

const withTruncation = async (output: string, details: ToolDetails) => {
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return { text: truncation.content, details };
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-web-"));
	const tempFile = join(tempDir, "output.md");
	await withFileMutationQueue(tempFile, async () => writeFile(tempFile, output, "utf8"));

	const text = [
		truncation.content,
		"",
		`[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`,
	].join("\n");

	return {
		text,
		details: {
			...details,
			truncation,
			fullOutputPath: tempFile,
		},
	};
};

const textToolResult = async (output: string, details: ToolDetails) => {
	const truncated = await withTruncation(output.trimEnd(), details);
	return {
		content: [{ type: "text" as const, text: truncated.text }],
		details: truncated.details,
	};
};

const runLocalWebTool = async (
	pi: ExtensionAPI,
	args: string[],
	type: ToolDetails["type"],
	requestedProvider: SearchProvider | ExtractProvider,
	signal?: AbortSignal,
	fallbackReason?: string,
) => {
	const result = await pi.exec(SCRIPT_PATH, args, { signal, timeout: COMMAND_TIMEOUT_MS });
	if (result.code !== 0 || result.killed) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `web-search-and-extract exited with code ${result.code}`);
	}

	const output = result.stdout.trimEnd();
	const stderr = [fallbackReason, optionalText(result.stderr)].filter((value): value is string => Boolean(value)).join("\n");
	const details: ToolDetails = {
		type,
		args,
		provider: parseProvider(output),
		requestedProvider,
		...(stderr ? { stderr } : {}),
	};
	return textToolResult(output, details);
};

const decodeBase64Url = (value: string) => {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return atob(padded);
};

const accountIdFromToken = (token: string) => {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = asObject(JSON.parse(decodeBase64Url(payload)));
		return stringValue(asObject(claims?.[ACCOUNT_ID_CLAIM])?.chatgpt_account_id);
	} catch {
		return undefined;
	}
};

const headerValue = (headers: Record<string, string> | undefined, name: string) => {
	const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return entry?.[1];
};

const resolveCodexModel = (ctx: ExtensionContext) => {
	if (ctx.model?.provider === CODEX_PROVIDER) return ctx.model;
	return ctx.modelRegistry.find(CODEX_PROVIDER, DEFAULT_CODEX_MODEL) ?? ctx.modelRegistry.getAvailable().find((model) => model.provider === CODEX_PROVIDER) ?? ctx.modelRegistry.getAll().find((model) => model.provider === CODEX_PROVIDER);
};

const resolveCodexAuth = async (ctx: ExtensionContext): Promise<CodexAuth> => {
	const model = resolveCodexModel(ctx);
	if (!model) throw new Error("No openai-codex model is registered in Pi");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`OpenAI Codex auth failed: ${auth.error}`);
	if (!auth.apiKey) throw new Error("OpenAI Codex auth did not provide a bearer token");

	return {
		model: model.id,
		token: auth.apiKey,
		accountId: headerValue(auth.headers, "ChatGPT-Account-ID") ?? accountIdFromToken(auth.apiKey),
		extraHeaders: auth.headers,
	};
};

const codexHeaders = (auth: CodexAuth) => ({
	...(auth.extraHeaders ?? {}),
	accept: "application/json",
	"content-type": "application/json",
	"user-agent": CODEX_USER_AGENT,
	version: CODEX_USER_AGENT,
	authorization: `Bearer ${auth.token}`,
	...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
});

const requestSignal = (signal: AbortSignal | undefined) => {
	const timeout = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const searchResponseLength = (maxResults: number) => {
	if (maxResults <= 3) return "short";
	if (maxResults <= 10) return "medium";
	return "long";
};

const recencyDays = (timelimit: "d" | "w" | "m" | "y" | undefined) => {
	if (timelimit === "d") return 1;
	if (timelimit === "w") return 7;
	if (timelimit === "m") return 31;
	if (timelimit === "y") return 365;
	return undefined;
};

const codexInput = (text: string) => [
	{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
	},
];

const postCodexSearch = async (ctx: ExtensionContext, body: JsonObject, signal?: AbortSignal) => {
	const auth = await resolveCodexAuth(ctx);
	const response = await fetch(CODEX_SEARCH_ENDPOINT, {
		method: "POST",
		headers: codexHeaders(auth),
		body: JSON.stringify({ ...body, model: auth.model }),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		const body = (await response.text()).trim();
		throw new Error(`OpenAI Codex web search failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 1000)}` : ""}`);
	}

	const payload = asObject(await response.json());
	const output = stringValue(payload?.output)?.trim();
	if (!output) throw new Error("OpenAI Codex web search returned empty output");
	return output;
};

const runCodexSearch = async (ctx: ExtensionContext, query: string, maxResults: number, timelimit: "d" | "w" | "m" | "y" | undefined, requestedProvider: SearchProvider, signal?: AbortSignal) => {
	const queryCommand: JsonObject = { q: query };
	const recency = recencyDays(timelimit);
	if (recency) queryCommand.recency = recency;

	const output = await postCodexSearch(
		ctx,
		{
			id: `${CODEX_REQUEST_ID_PREFIX}-${Date.now()}`,
			input: codexInput(`Search the web for: ${query}`),
			commands: {
				search_query: [queryCommand],
				response_length: searchResponseLength(maxResults),
			},
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: CODEX_MAX_OUTPUT_TOKENS,
		},
		signal,
	);

	return textToolResult(`Provider: openai-codex\nQuery: ${query}\n\n${output}`, {
		type: "search",
		provider: "openai-codex",
		requestedProvider,
	});
};

const runCodexExtract = async (ctx: ExtensionContext, url: string, requestedProvider: ExtractProvider, signal?: AbortSignal) => {
	const output = await postCodexSearch(
		ctx,
		{
			id: `${CODEX_REQUEST_ID_PREFIX}-${Date.now()}`,
			input: codexInput(`Open ${url} and extract the page content as markdown.`),
			commands: {
				open: [{ ref_id: url }],
				response_length: "long",
			},
			settings: {
				allowed_callers: ["direct"],
				external_web_access: true,
			},
			max_output_tokens: CODEX_MAX_OUTPUT_TOKENS,
		},
		signal,
	);

	return textToolResult(`Provider: openai-codex\nURL: ${url}\n\n${output}`, {
		type: "extract",
		provider: "openai-codex",
		requestedProvider,
	});
};

const localSearchArgs = (query: string, maxResults: number, params: { region?: string; timelimit?: "d" | "w" | "m" | "y"; backend?: string }) => {
	const args = ["search", query, "--max-results", String(maxResults)];
	const region = optionalText(params.region);
	const backend = optionalText(params.backend);
	if (region) args.push("--region", region);
	if (params.timelimit) args.push("--timelimit", params.timelimit);
	if (backend) args.push("--backend", backend);
	return args;
};

const localExtractArgs = (url: string, provider: "ddgs" | "camoufox" | "auto", timeout: number) => ["extract", url, "--provider", provider, "--timeout", String(timeout)];

const runSearch = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	query: string,
	provider: SearchProvider,
	maxResults: number,
	params: { region?: string; timelimit?: "d" | "w" | "m" | "y"; backend?: string },
	localMode: boolean,
	signal?: AbortSignal,
) => {
	if (localMode) {
		if (provider === "codex") throw new Error("OpenAI Codex is disabled by /local; use provider auto or ddgs");
		return runLocalWebTool(pi, localSearchArgs(query, maxResults, params), "search", provider, signal);
	}
	if (provider === "ddgs") return runLocalWebTool(pi, localSearchArgs(query, maxResults, params), "search", provider, signal);
	if (provider === "codex") return runCodexSearch(ctx, query, maxResults, params.timelimit, provider, signal);

	try {
		return await runCodexSearch(ctx, query, maxResults, params.timelimit, provider, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		const fallbackReason = `OpenAI Codex provider unavailable; fell back to DDGS: ${errorMessage(error)}`;
		try {
			return await runLocalWebTool(pi, localSearchArgs(query, maxResults, params), "search", provider, signal, fallbackReason);
		} catch (fallbackError) {
			throw new Error(`${fallbackReason}; DDGS fallback failed: ${errorMessage(fallbackError)}`);
		}
	}
};

const runExtract = async (pi: ExtensionAPI, ctx: ExtensionContext, url: string, provider: ExtractProvider, timeout: number, localMode: boolean, signal?: AbortSignal) => {
	if (localMode) {
		if (provider === "codex") throw new Error("OpenAI Codex is disabled by /local; use provider auto, ddgs, or camoufox");
		return runLocalWebTool(pi, localExtractArgs(url, provider, timeout), "extract", provider, signal);
	}
	if (provider === "codex") return runCodexExtract(ctx, url, provider, signal);
	if (provider === "ddgs" || provider === "camoufox") return runLocalWebTool(pi, localExtractArgs(url, provider, timeout), "extract", provider, signal);

	try {
		return await runCodexExtract(ctx, url, provider, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		const fallbackReason = `OpenAI Codex provider unavailable; fell back to DDGS/Camoufox auto: ${errorMessage(error)}`;
		try {
			return await runLocalWebTool(pi, localExtractArgs(url, "auto", timeout), "extract", provider, signal, fallbackReason);
		} catch (fallbackError) {
			throw new Error(`${fallbackReason}; DDGS/Camoufox fallback failed: ${errorMessage(fallbackError)}`);
		}
	}
};

const compactResult = (result: { content: Array<{ type: string; text?: string }>; details?: unknown }, expanded: boolean, theme: { fg(role: string, text: string): string }) => {
	const details = result.details as ToolDetails | undefined;
	const provider = details?.provider ? `Provider: ${details.provider}` : "Provider: unknown";
	let text = theme.fg(details?.truncation?.truncated ? "warning" : "success", details?.truncation?.truncated ? `${provider} (truncated)` : provider);
	if (details?.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
	if (!expanded) return text;

	const content = result.content[0];
	const output = content?.type === "text" ? content.text ?? "" : "";
	const preview = output.split("\n").slice(0, 24).join("\n");
	return `${text}\n${theme.fg("dim", preview)}`;
};

export default function webSearchAndExtractExtension(pi: ExtensionAPI) {
	let localMode = false;

	const setLocalModeStatus = (ctx: ExtensionContext) => {
		const value = localMode ? "on" : "off";
		ctx.ui.setStatus("local", ctx.ui.theme.fg("dim", "local ") + ctx.ui.theme.fg("accent", value));
	};

	pi.on("session_start", (_event, ctx) => {
		localMode = readStoredLocalMode(ctx.sessionManager.getEntries() as StoredEntry[]);
		setLocalModeStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (!localMode) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nLocal web mode is enabled. web_search and web_extract must not use provider codex; provider auto uses only local DDGS/Camoufox backends.`,
		};
	});

	pi.registerCommand("local", {
		description: "Toggle local web mode, disabling OpenAI Codex for web search and extraction (on, off, toggle)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") localMode = true;
			else if (action === "off") localMode = false;
			else if (action === "" || action === "toggle") localMode = !localMode;
			else {
				ctx.ui.notify("Usage: /local [on|off|toggle]", "warning");
				return;
			}

			pi.appendEntry(LOCAL_MODE_CUSTOM_TYPE, { enabled: localMode });
			setLocalModeStatus(ctx);
			ctx.ui.notify(`Local web mode ${localMode ? "on" : "off"} for this session`, "info");
		},
	});

	pi.registerTool(withStatusCard({
		name: "web_search",
		label: "Web Search",
		description: `Search the web with OpenAI Codex by default, falling back to DDGS in auto mode. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the web with OpenAI Codex by default and return markdown results",
		promptGuidelines: [
			"Use web_search for source discovery, current facts, and broad web research.",
			"web_search defaults to provider auto: OpenAI Codex first, then DDGS fallback if Codex auth or the endpoint is unavailable.",
			"web_search snippets are leads; use web_extract on the best source URLs before relying on exact facts.",
			"Keep web_search maxResults small unless the task needs a broad survey.",
		],
		parameters: SearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("query is required");

			const provider = params.provider ?? "auto";
			const maxResults = checkedInteger(params.maxResults, DEFAULT_MAX_RESULTS, "maxResults", 1, 25);
			return runSearch(pi, ctx, query, provider, maxResults, params, localMode, signal);
		},
		renderCall(args, theme) {
			const query = args.query ? ` \"${args.query}\"` : "";
			const provider = theme.fg("dim", ` (${args.provider ?? (localMode ? "auto→local" : "auto→codex")})`);
			const limit = args.maxResults ? theme.fg("dim", ` max=${args.maxResults}`) : "";
			return new Text(theme.fg("toolTitle", theme.bold("web_search")) + theme.fg("accent", query) + provider + limit, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return new Text(compactResult(result, expanded, theme), 0, 0);
		},
	}));

	pi.registerTool(withStatusCard({
		name: "web_extract",
		label: "Web Extract",
		description: `Extract a URL to markdown with OpenAI Codex by default, falling back to DDGS/Camoufox in auto mode. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Extract a URL to markdown using OpenAI Codex first with DDGS/Camoufox fallback",
		promptGuidelines: [
			"Use web_extract on source URLs before relying on exact web facts.",
			"web_extract defaults to provider auto: OpenAI Codex first, then DDGS/Camoufox fallback if Codex auth or the endpoint is unavailable.",
			"Use web_extract provider codex, ddgs, or camoufox only when you need to isolate one method.",
			"Use browser automation directly instead of web_extract for login, clicks, screenshots, or stateful flows.",
		],
		parameters: ExtractParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const url = params.url.trim();
			if (!url) throw new Error("url is required");
			const provider = params.provider ?? "auto";
			const timeout = checkedNumber(params.timeout, DEFAULT_EXTRACT_TIMEOUT_SECONDS, "timeout", 1, 60);
			return runExtract(pi, ctx, url, provider, timeout, localMode, signal);
		},
		renderCall(args, theme) {
			const provider = theme.fg("dim", ` (${args.provider ?? (localMode ? "auto→local" : "auto→codex")})`);
			return new Text(theme.fg("toolTitle", theme.bold("web_extract ")) + theme.fg("accent", args.url ?? "...") + provider, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return new Text(compactResult(result, expanded, theme), 0, 0);
		},
	}));
}
