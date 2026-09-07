import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_MARKER = "__trippSyntaxPunctuationPatched";
const MARKDOWN_PATCH_MARKER = "__trippSyntaxPunctuationMarkdownPatched";
const IPYTHON_PATCH_MARKER = "__trippSyntaxPunctuationIpythonPatched";
const TOOL_EXECUTION_PATCH_MARKER = "__trippSyntaxPunctuationToolExecutionPatched";
const ANSI_SGR = /\x1b\[([0-9;]*)m/g;
const HTML_PART = /(<span class="hljs-[^"]+">|<\/span>)/;
const OPEN_SPAN = /^<span class="hljs-([^"]+)">$/;
const SYNTAX_TOKEN = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|[()[\]{}.,;:+*/%!=?&|^~<>-]/gi;
const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ".", ",", ";", ":"]);
const PROTECTED_SCOPES = new Set([
	"comment",
	"doctag",
	"literal",
	"meta",
	"number",
	"operator",
	"punctuation",
	"regexp",
	"string",
]);

type HighlightResult = { value: string } & Record<string, unknown>;
type Highlighter = {
	highlight: (...args: unknown[]) => HighlightResult;
	[PATCH_MARKER]?: boolean;
};

const decodedEntity = (token: string) => {
	if (token === "&amp;") return "&";
	if (token === "&lt;") return "<";
	if (token === "&gt;") return ">";
	return undefined;
};

const decorateText = (text: string) => text.replace(SYNTAX_TOKEN, (token) => {
	const character = token.startsWith("&") ? decodedEntity(token) : token;
	if (!character) return token;
	const scope = PUNCTUATION.has(character) ? "punctuation" : "operator";
	return `<span class="hljs-${scope}">${token}</span>`;
});

const isProtected = (scope: string) => PROTECTED_SCOPES.has(scope.split(/[.-]/, 1)[0]);

export const decorateHighlightedHtml = (html: string) => {
	const scopes: string[] = [];
	return html.split(HTML_PART).map((part) => {
		if (part.startsWith("<span")) {
			const match = OPEN_SPAN.exec(part);
			if (!match) throw new Error(`Unexpected highlight span: ${part}`);
			scopes.push(match[1]);
			return part;
		}
		if (part === "</span>") {
			scopes.pop();
			return part;
		}
		return scopes.some(isProtected) ? part : decorateText(part);
	}).join("");
};

export const patchHighlighter = (highlighter: Highlighter) => {
	if (highlighter[PATCH_MARKER]) return;
	const highlight = highlighter.highlight;
	highlighter.highlight = function (...args) {
		const result = highlight.apply(this, args);
		return { ...result, value: decorateHighlightedHtml(result.value) };
	};
	highlighter[PATCH_MARKER] = true;
};

type SyntaxScope = "operator" | "punctuation";
type SyntaxStyler = (scope: SyntaxScope, text: string) => string;

const decoratePlainText = (text: string, style: SyntaxStyler) => text.replace(SYNTAX_TOKEN, (token) => {
	const character = token.startsWith("&") ? decodedEntity(token) : token;
	if (!character) return token;
	return style(PUNCTUATION.has(character) ? "punctuation" : "operator", token);
});

export const decorateAnsiHighlightedText = (text: string, style: SyntaxStyler) => {
	let result = "";
	let offset = 0;
	let hasForeground = false;

	for (const match of text.matchAll(ANSI_SGR)) {
		const index = match.index ?? 0;
		const plain = text.slice(offset, index);
		result += hasForeground ? plain : decoratePlainText(plain, style);
		result += match[0];

		const parameters = (match[1] || "0").split(";").map(Number);
		for (const parameter of parameters) {
			if (parameter === 0 || parameter === 39) hasForeground = false;
			else if ((parameter >= 30 && parameter <= 37) || parameter === 38 || (parameter >= 90 && parameter <= 97)) {
				hasForeground = true;
			}
		}
		offset = index + match[0].length;
	}

	const remaining = text.slice(offset);
	return result + (hasForeground ? remaining : decoratePlainText(remaining, style));
};

type MarkdownClass = {
	prototype: {
		renderCodeBlock: (token: unknown) => string[];
		[MARKDOWN_PATCH_MARKER]?: boolean;
	};
};

type PrimeTheme = {
	fg: (color: "syntaxOperator" | "syntaxPunctuation", text: string) => string;
};

type IpythonCell = {
	highlightInputLine: (line: string, isBashCell: boolean) => string;
	[IPYTHON_PATCH_MARKER]?: boolean;
};

type ToolExecutionClass = {
	prototype: {
		updateDisplay: () => void;
		ipythonCellComponent?: IpythonCell;
		[TOOL_EXECUTION_PATCH_MARKER]?: boolean;
	};
};

const decoratePrimeSyntax = (text: string, theme: PrimeTheme) => decorateAnsiHighlightedText(
	text,
	(scope, value) => theme.fg(scope === "punctuation" ? "syntaxPunctuation" : "syntaxOperator", value),
);

export const patchPrimeMarkdown = (Markdown: MarkdownClass, theme: PrimeTheme) => {
	const prototype = Markdown.prototype;
	if (prototype[MARKDOWN_PATCH_MARKER]) return;
	const renderCodeBlock = prototype.renderCodeBlock;
	prototype.renderCodeBlock = function (token: unknown) {
		return renderCodeBlock.call(this, token).map((line) => decoratePrimeSyntax(line, theme));
	};
	prototype[MARKDOWN_PATCH_MARKER] = true;
};

const patchIpythonCell = (cell: IpythonCell, theme: PrimeTheme) => {
	if (cell[IPYTHON_PATCH_MARKER]) return;
	const highlightInputLine = cell.highlightInputLine;
	cell.highlightInputLine = function (line: string, isBashCell: boolean) {
		const highlighted = highlightInputLine.call(this, line, isBashCell);
		return isBashCell ? highlighted : decoratePrimeSyntax(highlighted, theme);
	};
	cell[IPYTHON_PATCH_MARKER] = true;
};

export const patchPrimeToolExecution = (ToolExecution: ToolExecutionClass, theme: PrimeTheme) => {
	const prototype = ToolExecution.prototype;
	if (prototype[TOOL_EXECUTION_PATCH_MARKER]) return;
	const updateDisplay = prototype.updateDisplay;
	prototype.updateDisplay = function () {
		updateDisplay.call(this);
		if (this.ipythonCellComponent) patchIpythonCell(this.ipythonCellComponent, theme);
	};
	prototype[TOOL_EXECUTION_PATCH_MARKER] = true;
};

const findPrimeBundleModules = (cliPath: string) => {
	const bundleDirectory = dirname(realpathSync(cliPath));
	let markdown: string | undefined;
	let toolExecution: string | undefined;
	for (const name of readdirSync(bundleDirectory)) {
		if (!name.endsWith(".js")) continue;
		const path = join(bundleDirectory, name);
		const source = readFileSync(path, "utf8");
		if (source.includes("var Markdown = class") && source.includes("renderCodeBlock(token)") && source.includes("syntaxPunctuation")) {
			markdown = path;
		}
		if (source.includes("var ToolExecutionComponent = class") && source.includes("IPythonCellComponent")) {
			toolExecution = path;
		}
		if (markdown && toolExecution) return { markdown, toolExecution };
	}
	return markdown ? { markdown, toolExecution } : undefined;
};

const patchRuntimeHighlighter = async () => {
	const cliPath = process.argv[1];
	if (!cliPath) throw new Error("Cannot locate the agent executable");

	const primeBundleModules = findPrimeBundleModules(cliPath);
	if (primeBundleModules) {
		const markdownModule = await import(pathToFileURL(primeBundleModules.markdown).href);
		patchPrimeMarkdown(markdownModule.Markdown, markdownModule.theme);
		if (primeBundleModules.toolExecution) {
			const toolModule = await import(pathToFileURL(primeBundleModules.toolExecution).href);
			patchPrimeToolExecution(toolModule.ToolExecutionComponent, markdownModule.theme);
		}
		return;
	}

	const requireFromAgent = createRequire(realpathSync(cliPath));
	patchHighlighter(requireFromAgent("highlight.js/lib/index.js") as Highlighter);
};

export default async function (_pi: ExtensionAPI) {
	await patchRuntimeHighlighter();
}
