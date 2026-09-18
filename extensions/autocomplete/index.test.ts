import { describe, expect, test } from "bun:test";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

const {
	default: autocompleteExtension,
	canInstallAutocomplete,
	createAutocompleteProvider,
	createFileSearch,
	extractCompletionMode,
	fuzzyPathPattern,
	rankFuzzyMatches,
	skillItems,
} = await import("./index.ts");

const commands = [
	{ name: "skill:release-notes", description: "Write release notes", source: "skill" },
	{ name: "skill:frontend-design", description: "Build web interfaces", source: "skill" },
	{ name: "reload", description: "Reload Pi", source: "extension" },
];

const providerItems: AutocompleteItem[] = [
	{ value: "reload", label: "reload", description: "Reload Pi" },
	{ value: "resume", label: "resume", description: "Resume a session" },
	{ value: "rename", label: "rename", description: "Rename the session" },
];

function createFallback() {
	const calls: Array<{ lines: string[]; cursorCol: number }> = [];
	const provider: AutocompleteProvider = {
		async getSuggestions(lines, _cursorLine, cursorCol) {
			calls.push({ lines, cursorCol });
			return { prefix: lines[0] ?? "", items: providerItems };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines: ["delegated"], cursorLine, cursorCol };
		},
	};
	return { provider, calls };
}

const noFiles = async () => [];

const signal = () => new AbortController().signal;

describe("extractCompletionMode", () => {
	test.each([
		["/rn", { kind: "command", query: "rn", prefix: "/rn" }],
		["review @hda", { kind: "file", query: "hda", prefix: "@hda", quoted: false }],
		['review @"home dot', { kind: "file", query: "home dot", prefix: '@"home dot', quoted: true }],
		["use $fd", { kind: "skill", query: "fd", prefix: "$fd" }],
		["use $skill:fd", { kind: "skill", query: "skill:fd", prefix: "$skill:fd" }],
	] as const)("recognizes %s", (text, expected) => {
		expect(extractCompletionMode(text)).toEqual(expected);
	});

	test.each(["plain text", "cost$project", "path@file", "/reload now"])("ignores %s", (text) => {
		expect(extractCompletionMode(text)).toBeUndefined();
	});
});

test.each([
	["Pi TUI", { hasUI: true, mode: "tui" }, true],
	["Prime TUI", { hasUI: true }, true],
	["Pi RPC", { hasUI: true, mode: "rpc" }, false],
	["headless", { hasUI: false }, false],
] as const)("installs only in a supported %s context", (_name, ctx, expected) => {
	expect(canInstallAutocomplete(ctx)).toBe(expected);
});

test("registers one provider for all completion modes", () => {
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	autocompleteExtension({
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		getCommands: () => commands,
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as never);

	let providerRegistered = false;
	sessionStart?.({}, {
		hasUI: true,
		cwd: "/repo",
		ui: {
			addAutocompleteProvider() {
				providerRegistered = true;
			},
		},
	});

	expect(providerRegistered).toBe(true);
});

test("fuzzy matches slash commands against the complete command list", async () => {
	const fallback = createFallback();
	const provider = createAutocompleteProvider(fallback.provider, () => commands, noFiles);
	const suggestions = await provider.getSuggestions(["/rn"], 0, 3, { signal: signal() });

	expect(suggestions?.prefix).toBe("/rn");
	expect(suggestions?.items[0]).toEqual({
		value: "rename",
		label: "rename",
		description: "Rename the session",
	});
	expect(fallback.calls).toEqual([{ lines: ["/"], cursorCol: 1 }]);
});

test("ranks by shortest matched substring, then by whole match length", () => {
	expect(rankFuzzyMatches(
		["a---b---c", "zzabc-very-long", "abc", "not-a-match"],
		"abc",
		(item) => item,
	)).toEqual(["abc", "zzabc-very-long", "a---b---c"]);
});

test("uses whole path length to break equal-span file matches", () => {
	expect(rankFuzzyMatches(
		["home/dot_aerospace", "home/dot_agents"],
		"hda",
		(item) => item,
	)).toEqual(["home/dot_agents", "home/dot_aerospace"]);
});

test("fuzzy matches bare and canonical skill references", () => {
	expect(skillItems(commands, "fd")).toEqual([
		{
			value: "frontend-design",
			label: "frontend-design",
			description: "Build web interfaces",
		},
	]);
	expect(skillItems(commands, "skill:fd")).toEqual(skillItems(commands, "fd"));
});

test.each([
	["use $fd now", 7],
	["use $skill:fd now", 13],
])("skill completion from %s inserts one canonical prefix", async (line, cursorCol) => {
	const fallback = createFallback();
	const provider = createAutocompleteProvider(fallback.provider, () => commands, noFiles);
	const suggestions = await provider.getSuggestions([line], 0, cursorCol, { signal: signal() });
	const result = provider.applyCompletion([line], 0, cursorCol, suggestions!.items[0]!, suggestions!.prefix);

	expect(result).toEqual({
		lines: ["use $skill:frontend-design now"],
		cursorLine: 0,
		cursorCol: 26,
	});
});

test("fuzzy file completion uses discovered paths", async () => {
	const fallback = createFallback();
	const provider = createAutocompleteProvider(
		fallback.provider,
		() => commands,
		async () => [{
			value: "@home/dot_agents/",
			label: "dot_agents/",
			description: "home/dot_agents",
		}],
	);
	const suggestions = await provider.getSuggestions(["review @hda"], 0, 11, { signal: signal() });

	expect(suggestions).toEqual({
		prefix: "@hda",
		items: [{
			value: "@home/dot_agents/",
			label: "dot_agents/",
			description: "home/dot_agents",
		}],
	});
	expect(fallback.calls).toEqual([]);
});

test.each([
	["/rn", "/rn", { value: "rename", label: "rename" }],
	["review @hda", "@hda", { value: "@home/dot_agents/", label: "dot_agents/" }],
] as const)("%s completion delegates insertion to Pi", (line, prefix, item) => {
	const fallback = createFallback();
	const provider = createAutocompleteProvider(fallback.provider, () => commands, noFiles);
	expect(provider.applyCompletion([line], 0, line.length, item, prefix)).toEqual({
		lines: ["delegated"],
		cursorLine: 0,
		cursorCol: line.length,
	});
});

test("non-autocomplete input delegates to the existing provider", async () => {
	const fallback = createFallback();
	const provider = createAutocompleteProvider(fallback.provider, () => commands, noFiles);
	await provider.getSuggestions(["plain text"], 0, 10, { signal: signal() });
	expect(fallback.calls).toEqual([{ lines: ["plain text"], cursorCol: 10 }]);
});

test("builds an fd regex for ordered fuzzy path characters", () => {
	expect(fuzzyPathPattern("home/dpa")).toBe("h.*o.*m.*e.*[\\\\/].*d.*p.*a");
	expect(fuzzyPathPattern("./")).toBe(".");
});

test("fd results are fuzzy-ranked and formatted for completion", async () => {
	const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
	const search = createFileSearch(async (command, args, options) => {
		calls.push({ command, args, cwd: options.cwd });
		return {
			code: 0,
			stdout: [
				"/repo/home/dot_aerospace.toml",
				"/repo/home/dot_agents/",
				"/repo/home/dot_pi/agent/extensions/autocomplete/index.ts",
				"/repo/README.md",
			].join("\n"),
		};
	}, "/repo", "/Users/test");

	const items = await search("hda", false, signal());
	expect(items?.[0]).toEqual({
		value: "@home/dot_agents/",
		label: "dot_agents/",
		description: "home/dot_agents",
	});
	expect(items).toContainEqual({
		value: "@home/dot_agents/",
		label: "dot_agents/",
		description: "home/dot_agents",
	});
	expect(calls[0]?.command).toBe("fd");
	expect(calls[0]?.cwd).toBe("/repo");
	expect(calls[0]?.args).toContain("--full-path");
	expect(calls[0]?.args).toContain("--ignore-case");
	expect(calls[0]?.args).toContain("h.*d.*a");
	expect(calls[0]?.args.at(-1)).toBe(".");
});

test("quoted file completion preserves quotes and spaces", async () => {
	const search = createFileSearch(async () => ({
		code: 0,
		stdout: "/repo/docs/release notes.md\n",
	}), "/repo", "/Users/test");

	await expect(search("docs/rn", true, signal())).resolves.toEqual([
		{
			value: '@"docs/release notes.md"',
			label: "release notes.md",
			description: "docs/release notes.md",
		},
	]);
});

test("falls back to Pi file completion when fd fails", async () => {
	const fallback = createFallback();
	const provider = createAutocompleteProvider(
		fallback.provider,
		() => commands,
		async () => undefined,
	);
	await provider.getSuggestions(["review @file"], 0, 12, { signal: signal() });
	expect(fallback.calls).toEqual([{ lines: ["review @file"], cursorCol: 12 }]);
});
