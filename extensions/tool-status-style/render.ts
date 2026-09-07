import {
	getLanguageFromPath,
	highlightCode,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, Text, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONTEXT_LINES = 3;
const OUTPUT_LINE_LIMIT = 160;

type Theme = ExtensionContext["ui"]["theme"];
type RenderedLine = { text: string; highlighted?: string };
type LinePart = { kind: "context" | "remove" | "add" | "skip"; text: string; highlighted?: string };
export type DiffSpan = { text: string; changed: boolean };
export type FileChange = { kind: "add" | "update"; path: string; before: string; after: string };
type Preview = { change?: FileChange; diff?: string; warning?: string };
type PreviewText = Text & { preview?: Preview; previewKey?: string; previewPending?: boolean; settled?: boolean };
export type FileToolRenderState = { callComponent?: PreviewText };

const normalizeToLF = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const stripBom = (text: string) => text.startsWith("\uFEFF") ? text.slice(1) : text;

const splitLines = (text: string) => {
	if (!text) return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
};

const languageFromPath = (path: string) => {
	const language = getLanguageFromPath(path);
	if (language || !path.endsWith(".tmpl")) return language;
	return getLanguageFromPath(path.slice(0, -".tmpl".length));
};

export const renderLines = (text: string, path: string): RenderedLine[] => {
	const lines = splitLines(text);
	const language = languageFromPath(path);
	if (!language) return lines.map((line) => ({ text: line }));
	const highlighted = highlightCode(lines.join("\n"), language);
	return lines.map((line, index) => ({
		text: line,
		highlighted: highlighted[index] ?? line,
	}));
};

const lineDiff = (before: string, after: string, path: string): LinePart[] => {
	const oldLines = renderLines(before, path);
	const newLines = renderLines(after, path);
	const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
			table[oldIndex][newIndex] = oldLines[oldIndex].text === newLines[newIndex].text
				? table[oldIndex + 1][newIndex + 1] + 1
				: Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
		}
	}

	const parts: LinePart[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length && newIndex < newLines.length) {
		if (oldLines[oldIndex].text === newLines[newIndex].text) {
			parts.push({ kind: "context", ...oldLines[oldIndex++] });
			newIndex++;
		} else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
			parts.push({ kind: "remove", ...oldLines[oldIndex++] });
		} else parts.push({ kind: "add", ...newLines[newIndex++] });
	}
	while (oldIndex < oldLines.length) parts.push({ kind: "remove", ...oldLines[oldIndex++] });
	while (newIndex < newLines.length) parts.push({ kind: "add", ...newLines[newIndex++] });
	return parts;
};

const compact = (parts: LinePart[]) => {
	const changed = parts.flatMap((part, index) => part.kind === "context" ? [] : [index]);
	if (!changed.length) return parts;
	const visible = new Set<number>();
	for (const index of changed) {
		for (let nearby = Math.max(0, index - CONTEXT_LINES); nearby <= Math.min(parts.length - 1, index + CONTEXT_LINES); nearby++) visible.add(nearby);
	}
	const output: LinePart[] = [];
	let hidden = 0;
	for (const [index, part] of parts.entries()) {
		if (visible.has(index) || part.kind !== "context") {
			if (hidden) output.push({ kind: "skip", text: `… ${hidden} unchanged line(s) hidden` });
			hidden = 0;
			output.push(part);
		} else hidden++;
	}
	if (hidden) output.push({ kind: "skip", text: `… ${hidden} unchanged line(s) hidden` });
	return output;
};

const body = (part: LinePart) => (part.highlighted ?? part.text) || " ";

const appendSpan = (spans: DiffSpan[], text: string, changed: boolean) => {
	if (!text) return;
	const last = spans.at(-1);
	if (last?.changed === changed) last.text += text;
	else spans.push({ text, changed });
};

const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];

export const intraLineDiff = (before: string, after: string) => {
	const oldTokens = tokens(before);
	const newTokens = tokens(after);
	const table = Array.from({ length: oldTokens.length + 1 }, () => Array<number>(newTokens.length + 1).fill(0));
	for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
			table[oldIndex][newIndex] = oldTokens[oldIndex] === newTokens[newIndex]
				? table[oldIndex + 1][newIndex + 1] + 1
				: Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
		}
	}

	const removed: DiffSpan[] = [];
	const added: DiffSpan[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
		if (oldTokens[oldIndex] === newTokens[newIndex]) {
			appendSpan(removed, oldTokens[oldIndex], false);
			appendSpan(added, newTokens[newIndex], false);
			oldIndex++;
			newIndex++;
		} else if (newIndex >= newTokens.length || (oldIndex < oldTokens.length && table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1])) {
			appendSpan(removed, oldTokens[oldIndex++], true);
		} else {
			appendSpan(added, newTokens[newIndex++], true);
		}
	}

	return { removed, added };
};

export const renderChangedDiffLine = (theme: Theme, kind: "add" | "remove", line: RenderedLine, spans: DiffSpan[]) => {
	const color = kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
	const marker = theme.fg(color, kind === "add" ? "+ " : "- ");
	const highlighted = spans.some((span) => !span.changed)
		? line.highlighted ?? theme.fg("text", line.text || " ")
		: "";
	let column = 0;
	const content = spans.map((span) => {
		const width = visibleWidth(span.text);
		const rendered = span.changed
			? theme.fg(color, span.text || " ")
			: sliceByColumn(highlighted, column, width, true);
		column += width;
		return rendered;
	}).join("");
	return `${marker}${content}`;
};

export const renderFileDiff = (theme: Theme, change: FileChange) => {
	const parts = compact(lineDiff(change.before, change.after, change.path));
	const lines: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part.kind === "skip") {
			lines.push(theme.fg("dim", part.text));
			continue;
		}
		if (part.kind === "context") {
			lines.push(`${theme.fg("dim", "  ")}${body(part)}`);
			continue;
		}

		const next = parts[index + 1];
		if (part.kind === "remove" && next?.kind === "add") {
			const spans = intraLineDiff(part.text, next.text);
			lines.push(renderChangedDiffLine(theme, "remove", part, spans.removed));
			lines.push(renderChangedDiffLine(theme, "add", next, spans.added));
			index++;
			continue;
		}

		lines.push(renderChangedDiffLine(theme, part.kind, part, [{ text: part.text || " ", changed: true }]));
	}
	if (lines.length > OUTPUT_LINE_LIMIT) lines.splice(OUTPUT_LINE_LIMIT, Infinity, theme.fg("muted", "… additional diff lines hidden"));
	return lines.join("\n") || theme.fg("dim", "No textual changes detected.");
};

const renderGeneratedDiff = (theme: Theme, diff: string, path: string) => {
	const lines = diff.split("\n").map((line): LinePart => {
		const match = /^([+\- ])\s*\d*\s(.*)$/.exec(line);
		if (!match || match[2] === "...") return { kind: "skip", text: match?.[2] ?? line };
		const text = match[2];
		const highlighted = renderLines(text, path)[0]?.highlighted;
		return { kind: match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context", text, highlighted };
	});
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const part = lines[index];
		if (part.kind === "skip") {
			output.push(theme.fg("dim", part.text));
			continue;
		}
		if (part.kind === "context") {
			output.push(`${theme.fg("dim", "  ")}${body(part)}`);
			continue;
		}
		const next = lines[index + 1];
		if (part.kind === "remove" && next?.kind === "add") {
			const spans = intraLineDiff(part.text, next.text);
			output.push(renderChangedDiffLine(theme, "remove", part, spans.removed));
			output.push(renderChangedDiffLine(theme, "add", next, spans.added));
			index++;
			continue;
		}
		output.push(renderChangedDiffLine(theme, part.kind, part, [{ text: part.text || " ", changed: true }]));
	}
	return output.join("\n") || theme.fg("dim", "No textual changes detected.");
};

const toolTitle = (theme: Theme, name: string, path: string) =>
	`${theme.fg("toolTitle", theme.bold(name))} ${path}`;

export const formatFileToolCall = (theme: Theme, name: string, path: string, preview?: Preview) => {
	const title = toolTitle(theme, name, path);
	if (!preview) return `${title}\n${theme.fg("dim", "Preview loading…")}`;
	if (preview.warning) return `${title}\n${theme.fg("warning", preview.warning)}`;
	if (preview.diff !== undefined) return `${title}\n${renderGeneratedDiff(theme, preview.diff, path)}`;
	if (!preview.change) return title;
	return `${title}\n${renderFileDiff(theme, preview.change)}`;
};

const readOptional = async (cwd: string, path: string) => {
	try {
		return await readFile(resolve(cwd, path), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

const previewWrite = async (cwd: string, path: string, content: string): Promise<Preview> => {
	const existing = await readOptional(cwd, path);
	return {
		change: {
			kind: existing === undefined ? "add" : "update",
			path,
			before: existing === undefined ? "" : normalizeToLF(stripBom(existing)),
			after: normalizeToLF(content),
		},
	};
};

const previewEdit = async (
	cwd: string,
	path: string,
	edits: Array<{ oldText: string; newText: string }>,
): Promise<Preview> => {
	const existing = await readOptional(cwd, path);
	if (existing === undefined) return { warning: `Could not read file to edit: ${path}` };
	let before = normalizeToLF(stripBom(existing));
	const replacements: Array<{ index: number; oldText: string; newText: string }> = [];
	for (const [index, edit] of edits.entries()) {
		const oldText = normalizeToLF(edit.oldText);
		const newText = normalizeToLF(edit.newText);
		const match = before.indexOf(oldText);
		if (!oldText || match < 0) return { warning: `Could not find edit block ${index + 1} in ${path}` };
		if (before.indexOf(oldText, match + oldText.length) >= 0) return { warning: `Edit block ${index + 1} is not unique in ${path}` };
		replacements.push({ index: match, oldText, newText });
	}
	const ordered = [...replacements].sort((left, right) => left.index - right.index);
	for (let index = 1; index < ordered.length; index++) {
		if (ordered[index - 1].index + ordered[index - 1].oldText.length > ordered[index].index) {
			return { warning: `Edit blocks ${index} and ${index + 1} overlap in ${path}` };
		}
	}
	for (const replacement of ordered.toReversed()) {
		before = `${before.slice(0, replacement.index)}${replacement.newText}${before.slice(replacement.index + replacement.oldText.length)}`;
	}
	return { change: { kind: "update", path, before: normalizeToLF(stripBom(existing)), after: before } };
};

const getPreviewText = (
	context: { state: FileToolRenderState; lastComponent?: unknown },
): PreviewText => {
	const component = context.lastComponent instanceof Text
		? context.lastComponent as PreviewText
		: Object.assign(new Text("", 0, 0), { preview: undefined, previewKey: undefined, previewPending: false, settled: false });
	context.state.callComponent = component;
	return component;
};

const resetPreview = (component: PreviewText, previewKey: string) => {
	if (component.previewKey === previewKey) return;
	component.preview = undefined;
	component.previewKey = previewKey;
	component.previewPending = false;
	component.settled = false;
};

const loadPreview = (
	component: PreviewText,
	previewKey: string,
	loader: () => Promise<Preview>,
	invalidate: () => void,
) => {
	if (component.preview || component.previewPending) return;
	component.previewPending = true;
	void loader().then(
		(preview) => preview,
		(error) => ({ warning: error instanceof Error ? error.message : String(error) }),
	).then((preview) => {
		if (component.previewKey !== previewKey || component.settled) return;
		component.preview = preview;
		component.previewPending = false;
		invalidate();
	});
};

const resultText = (
	result: { content?: Array<{ type: string; text?: string }> },
	theme: Theme,
	isError?: boolean,
) => {
	if (!isError) return new Text("", 0, 0);
	const output = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
	return new Text(theme.fg("error", output), 0, 0);
};

const settleCall = (state: FileToolRenderState) => {
	const callComponent = state.callComponent;
	if (!callComponent) return;
	callComponent.settled = true;
	callComponent.previewPending = false;
};

const writePath = (args: { path?: unknown; file_path?: unknown } | undefined) => {
	if (typeof args?.path === "string") return args.path;
	if (typeof args?.file_path === "string") return args.file_path;
	return "";
};

const writeContent = (args: { content?: unknown } | undefined) =>
	typeof args?.content === "string" ? args.content : undefined;

const editInput = (args: {
	path?: unknown;
	file_path?: unknown;
	edits?: unknown;
	oldText?: unknown;
	newText?: unknown;
} | undefined) => {
	const path = writePath(args);
	if (!path) return undefined;
	if (Array.isArray(args?.edits) && args.edits.every((edit) =>
		edit && typeof edit === "object" && typeof edit.oldText === "string" && typeof edit.newText === "string"
	)) {
		return { path, edits: args.edits as Array<{ oldText: string; newText: string }> };
	}
	if (typeof args?.oldText === "string" && typeof args?.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}
	return undefined;
};

export const renderWriteCall = (
	args: { path?: string; file_path?: string; content?: string },
	theme: Theme,
	context: { state: FileToolRenderState; lastComponent?: unknown; argsComplete?: boolean; cwd: string; invalidate: () => void },
) => {
	const component = getPreviewText(context);
	const path = writePath(args);
	const content = writeContent(args);
	const previewKey = JSON.stringify({ path, content });
	resetPreview(component, previewKey);
	if (context.argsComplete && path && content !== undefined) {
		loadPreview(component, previewKey, () => previewWrite(context.cwd, path, content), context.invalidate);
	}
	component.setText(path && (content !== undefined || component.preview)
		? formatFileToolCall(theme, "write", path, context.argsComplete ? component.preview : { change: { kind: "add", path, before: "", after: normalizeToLF(content ?? "") } })
		: toolTitle(theme, "write", path || "..."));
	return component;
};

export const renderWriteResult = (
	result: { content?: Array<{ type: string; text?: string }> },
	_options: unknown,
	theme: Theme,
	context: { isError?: boolean; state: FileToolRenderState },
) => {
	settleCall(context.state);
	return resultText(result, theme, context.isError);
};

export const renderEditCall = (
	args: { path?: string; file_path?: string; edits?: Array<{ oldText: string; newText: string }>; oldText?: string; newText?: string },
	theme: Theme,
	context: { state: FileToolRenderState; lastComponent?: unknown; argsComplete?: boolean; cwd: string; invalidate: () => void },
) => {
	const component = getPreviewText(context);
	const input = editInput(args);
	const previewKey = input ? JSON.stringify(input) : "";
	resetPreview(component, previewKey);
	if (context.argsComplete && input) {
		loadPreview(component, previewKey, () => previewEdit(context.cwd, input.path, input.edits), context.invalidate);
	}
	component.setText(input
		? formatFileToolCall(theme, "edit", input.path, context.argsComplete ? component.preview : undefined)
		: toolTitle(theme, "edit", writePath(args) || "..."));
	return component;
};

export const renderEditResult = (
	result: { content?: Array<{ type: string; text?: string }>; details?: { diff?: string } },
	_options: unknown,
	theme: Theme,
	context: { args?: unknown; isError?: boolean; state: FileToolRenderState },
) => {
	settleCall(context.state);
	const input = editInput(context.args as Parameters<typeof editInput>[0]);
	if (!context.isError && context.state.callComponent && typeof result.details?.diff === "string" && input) {
		context.state.callComponent.preview = { diff: result.details.diff };
		context.state.callComponent.setText(formatFileToolCall(theme, "edit", input.path, context.state.callComponent.preview));
	}
	return resultText(result, theme, context.isError);
};
