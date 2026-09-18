import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_CANDIDATES = 1_000;
const MAX_SUGGESTIONS = 20;

type Command = {
	name: string;
	description?: string;
	source: string;
};

type UIContext = {
	hasUI: boolean;
	mode?: string;
};

type ExecResult = {
	stdout: string;
	code: number;
};

type Exec = (
	command: string,
	args: string[],
	options: { cwd: string; signal: AbortSignal; timeout: number },
) => Promise<ExecResult>;

type FileSearch = (query: string, quoted: boolean, signal: AbortSignal) => Promise<AutocompleteItem[] | undefined>;

type CompletionMode =
	| { kind: "command"; query: string; prefix: string }
	| { kind: "file"; query: string; prefix: string; quoted: boolean }
	| { kind: "skill"; query: string; prefix: string };

export const canInstallAutocomplete = (ctx: UIContext) =>
	ctx.hasUI && (ctx.mode === undefined || ctx.mode === "tui");

export function extractCompletionMode(textBeforeCursor: string): CompletionMode | undefined {
	if (textBeforeCursor.startsWith("/") && !/\s/.test(textBeforeCursor)) {
		return {
			kind: "command",
			query: textBeforeCursor.slice(1),
			prefix: textBeforeCursor,
		};
	}

	const quotedFile = textBeforeCursor.match(/(?:^|[\s=])(@"([^"]*))$/);
	if (quotedFile) {
		return {
			kind: "file",
			query: quotedFile[2] ?? "",
			prefix: quotedFile[1] ?? '@"',
			quoted: true,
		};
	}

	const file = textBeforeCursor.match(/(?:^|[\s=])(@[^\s@]*)$/);
	if (file) {
		const prefix = file[1] ?? "@";
		return {
			kind: "file",
			query: prefix.slice(1),
			prefix,
			quoted: false,
		};
	}

	const skill = textBeforeCursor.match(/(?:^|\s)(\$([^\s$]*))$/);
	if (skill) {
		return {
			kind: "skill",
			query: skill[2] ?? "",
			prefix: skill[1] ?? "$",
		};
	}

	return undefined;
}

function skillName(commandName: string): string {
	return commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
}

function shortestMatchSpan(query: string, text: string): number | undefined {
	const normalizedQuery = query.toLowerCase();
	const normalizedText = text.toLowerCase();
	let shortest = Number.POSITIVE_INFINITY;

	for (let start = normalizedText.indexOf(normalizedQuery[0] ?? ""); start !== -1;) {
		let queryIndex = 1;
		let textIndex = start + 1;
		while (queryIndex < normalizedQuery.length && textIndex < normalizedText.length) {
			if (normalizedText[textIndex] === normalizedQuery[queryIndex]) queryIndex += 1;
			textIndex += 1;
		}
		if (queryIndex === normalizedQuery.length) {
			shortest = Math.min(shortest, textIndex - start);
		}
		start = normalizedText.indexOf(normalizedQuery[0] ?? "", start + 1);
	}

	return Number.isFinite(shortest) ? shortest : undefined;
}

export function rankFuzzyMatches<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	const tokens = query.trim().split(/[\s/]+/).filter(Boolean);
	if (tokens.length === 0) return items;

	return items
		.map((item, index) => {
			const text = getText(item);
			let matchedLength = 0;
			for (const token of tokens) {
				const span = shortestMatchSpan(token, text);
				if (span === undefined) return undefined;
				matchedLength += span;
			}
			return { item, index, matchedLength, text };
		})
		.filter((match): match is NonNullable<typeof match> => match !== undefined)
		.sort((left, right) =>
			left.matchedLength - right.matchedLength
			|| left.text.length - right.text.length
			|| left.index - right.index,
		)
		.map((match) => match.item);
}

export function skillItems(commands: Command[], query: string): AutocompleteItem[] {
	const nameQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
	const skills = commands
		.filter((command) => command.source === "skill")
		.map((command) => {
			const name = skillName(command.name);
			return {
				value: name,
				label: name,
				description: command.description,
			};
		});
	const uniqueSkills = [...new Map(skills.map((skill) => [skill.value, skill])).values()];
	return rankFuzzyMatches(uniqueSkills, nameQuery, (skill) => skill.value).slice(0, MAX_SUGGESTIONS);
}

function commandItems(
	providerItems: AutocompleteItem[],
	commands: Command[],
	query: string,
): AutocompleteItem[] {
	const registeredItems = commands.map((command) => ({
		value: command.name,
		label: command.name,
		description: command.description,
	}));
	const items = [...new Map([...providerItems, ...registeredItems].map((item) => [item.value, item])).values()];
	return rankFuzzyMatches(items, query, (item) => item.value).slice(0, MAX_SUGGESTIONS);
}

function escapeRegexCharacter(character: string): string {
	return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

export function fuzzyPathPattern(query: string): string {
	const pathQuery = query.replace(/^~?[\\/]/, "").replace(/^\.\//, "");
	if (!pathQuery) return ".";
	return [...pathQuery]
		.map((character) => character === "/" || character === "\\" ? "[\\\\/]" : escapeRegexCharacter(character))
		.join(".*");
}

function pathScope(query: string, cwd: string, home: string) {
	if (query.startsWith("~/") || query === "~") {
		return {
			root: home,
			matchQuery: query === "~" ? "" : query.slice(2),
			displayPrefix: "~/",
		};
	}
	if (isAbsolute(query)) {
		return {
			root: resolve("/"),
			matchQuery: query.slice(1),
			displayPrefix: "/",
		};
	}
	return {
		root: cwd,
		matchQuery: query.replace(/^\.\//, ""),
		displayPrefix: query.startsWith("./") ? "./" : "",
	};
}

function formatFileItem(path: string, isDirectory: boolean, quoted: boolean): AutocompleteItem {
	const completionPath = isDirectory ? `${path}/` : path;
	const needsQuotes = quoted || completionPath.includes(" ");
	const value = needsQuotes ? `@"${completionPath}"` : `@${completionPath}`;
	const name = path.split("/").at(-1) ?? path;
	return {
		value,
		label: isDirectory ? `${name}/` : name,
		description: path,
	};
}

export function createFileSearch(exec: Exec, cwd: string, home = homedir()): FileSearch {
	return async (query, quoted, signal) => {
		const scope = pathScope(query, cwd, home);
		const result = await exec(
			"fd",
			[
				"--color", "never",
				"--ignore-case",
				"--hidden",
				"--follow",
				"--full-path",
				"--exclude", ".git",
				"--type", "f",
				"--type", "d",
				"--max-results", String(MAX_CANDIDATES),
				fuzzyPathPattern(scope.matchQuery),
				".",
			],
			{ cwd: scope.root, signal, timeout: 2_000 },
		);
		if (signal.aborted) return [];
		if (result.code !== 0) return undefined;

		const candidates: Array<{ path: string; isDirectory: boolean }> = [];
		for (const outputLine of result.stdout.split("\n")) {
			if (!outputLine) continue;
			const normalizedOutput = outputLine.replace(/\\/g, "/");
			const isDirectory = normalizedOutput.endsWith("/");
			const withoutTrailingSlash = isDirectory ? normalizedOutput.slice(0, -1) : normalizedOutput;
			const absolutePath = isAbsolute(withoutTrailingSlash)
				? withoutTrailingSlash
				: resolve(scope.root, withoutTrailingSlash);
			const relativePath = relative(scope.root, absolutePath).replace(/\\/g, "/");
			if (!relativePath || relativePath.startsWith("../")) continue;
			const path = `${scope.displayPrefix}${relativePath}`;
			candidates.push({ path, isDirectory });
		}

		const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
		return rankFuzzyMatches(uniqueCandidates, scope.matchQuery, (candidate) => candidate.path)
			.slice(0, MAX_SUGGESTIONS)
			.map((candidate) => formatFileItem(candidate.path, candidate.isDirectory, quoted));
	};
}

export function createAutocompleteProvider(
	current: AutocompleteProvider,
	getCommands: () => Command[],
	searchFiles: FileSearch,
): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const mode = extractCompletionMode(line.slice(0, cursorCol));
			if (!mode) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			if (mode.kind === "skill") {
				const items = skillItems(getCommands(), mode.query);
				return items.length > 0 ? { items, prefix: mode.prefix } : null;
			}

			if (mode.kind === "file") {
				const items = await searchFiles(mode.query, mode.quoted, options.signal);
				if (items === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				return items.length > 0 ? { items, prefix: mode.prefix } : null;
			}

			const discoveryLines = [...lines];
			discoveryLines[cursorLine] = "/";
			const discovered = await current.getSuggestions(discoveryLines, cursorLine, 1, options);
			if (options.signal.aborted) return null;
			const items = commandItems(discovered?.items ?? [], getCommands(), mode.query);
			return items.length > 0 ? { items, prefix: mode.prefix } : null;
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const mode = extractCompletionMode(line.slice(0, cursorCol));
			if (mode?.kind !== "skill" || prefix !== mode.prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const completedLines = [...lines];
			const start = cursorCol - prefix.length;
			const completedValue = `$skill:${skillName(item.value)}`;
			completedLines[cursorLine] = `${line.slice(0, start)}${completedValue}${line.slice(cursorCol)}`;
			return {
				lines: completedLines,
				cursorLine,
				cursorCol: start + completedValue.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!canInstallAutocomplete(ctx)) return;
		const searchFiles = createFileSearch(
			(command, args, options) => pi.exec(command, args, options),
			ctx.cwd,
		);
		ctx.ui.addAutocompleteProvider((current) =>
			createAutocompleteProvider(current, () => pi.getCommands(), searchFiles),
		);
	});
}
