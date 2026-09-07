import { describe, expect, test } from "bun:test";
import {
	decorateAnsiHighlightedText,
	decorateHighlightedHtml,
	patchHighlighter,
	patchPrimeMarkdown,
	patchPrimeToolExecution,
} from "./index.ts";

describe("decorateHighlightedHtml", () => {
	test("classifies unscoped punctuation and operators", () => {
		expect(decorateHighlightedHtml("result = call(value, 2) + other;")).toBe(
			'result <span class="hljs-operator">=</span> call<span class="hljs-punctuation">(</span>value<span class="hljs-punctuation">,</span> 2<span class="hljs-punctuation">)</span> <span class="hljs-operator">+</span> other<span class="hljs-punctuation">;</span>',
		);
	});

	test("classifies encoded comparison and boolean operators", () => {
		expect(decorateHighlightedHtml("left &lt; right &amp;&amp; right &gt; 0")).toBe(
			'left <span class="hljs-operator">&lt;</span> right <span class="hljs-operator">&amp;</span><span class="hljs-operator">&amp;</span> right <span class="hljs-operator">&gt;</span> 0',
		);
	});

	test("preserves punctuation inside strings and comments", () => {
		const html = '<span class="hljs-string">"call(a + b)"</span> <span class="hljs-comment">// (a + b)</span>';
		expect(decorateHighlightedHtml(html)).toBe(html);
	});

	test("decorates broad parameter scopes but preserves nested literals", () => {
		const html = '<span class="hljs-params">(value = <span class="hljs-string">"a+b"</span>)</span>';
		expect(decorateHighlightedHtml(html)).toBe(
			'<span class="hljs-params"><span class="hljs-punctuation">(</span>value <span class="hljs-operator">=</span> <span class="hljs-string">"a+b"</span><span class="hljs-punctuation">)</span></span>',
		);
	});
});

test("patchHighlighter decorates results once", () => {
	const highlighter = {
		highlight: () => ({ value: "call(value) + 1" }),
	};
	patchHighlighter(highlighter);
	patchHighlighter(highlighter);
	expect(highlighter.highlight().value).toBe(
		'call<span class="hljs-punctuation">(</span>value<span class="hljs-punctuation">)</span> <span class="hljs-operator">+</span> 1',
	);
});

test("decorateAnsiHighlightedText styles only unscoped syntax", () => {
	const red = "\x1b[31m";
	const reset = "\x1b[39m";
	const input = `call(value = ${red}"a+b"${reset}) + 1; ${red}// c+d${reset}`;
	expect(decorateAnsiHighlightedText(input, (scope, text) => `<${scope}>${text}</${scope}>`)).toBe(
		`call<punctuation>(</punctuation>value <operator>=</operator> ${red}"a+b"${reset}<punctuation>)</punctuation> <operator>+</operator> 1<punctuation>;</punctuation> ${red}// c+d${reset}`,
	);
});

test("patchPrimeMarkdown decorates bundled Prime code-block output once", () => {
	class Markdown {
		renderCodeBlock() {
			return ["  call(value) + 1"];
		}
	}
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};

	patchPrimeMarkdown(Markdown, theme);
	patchPrimeMarkdown(Markdown, theme);
	expect(new Markdown().renderCodeBlock()).toEqual([
		"  call<syntaxPunctuation>(</syntaxPunctuation>value<syntaxPunctuation>)</syntaxPunctuation> <syntaxOperator>+</syntaxOperator> 1",
	]);
});


test("patchPrimeToolExecution decorates IPython input once", () => {
	class ToolExecution {
		ipythonCellComponent?: { highlightInputLine: (line: string, isBashCell: boolean) => string };

		constructor() {
			this.updateDisplay();
		}

		updateDisplay() {
			this.ipythonCellComponent ??= {
				highlightInputLine: (line: string) => line.replace('"value"', '\x1b[31m"value"\x1b[39m'),
			};
		}
	}
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};

	patchPrimeToolExecution(ToolExecution, theme);
	patchPrimeToolExecution(ToolExecution, theme);
	const cell = new ToolExecution().ipythonCellComponent!;
	expect(cell.highlightInputLine('call("value") + 1', false)).toBe(
		'call<syntaxPunctuation>(</syntaxPunctuation>\x1b[31m"value"\x1b[39m<syntaxPunctuation>)</syntaxPunctuation> <syntaxOperator>+</syntaxOperator> 1',
	);
	expect(cell.highlightInputLine("echo $(date)", true)).toBe("echo $(date)");
});
