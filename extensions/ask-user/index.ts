// ask_user presents a bounded decision form with choice, multi-select, and text questions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { withStatusCard } from "../tool-status-style/style.ts";
import {
	ASK_USER_PARAMETER_DESCRIPTIONS,
	ASK_USER_PROMPT_GUIDELINES,
	ASK_USER_PROMPT_SNIPPET,
	ASK_USER_TOOL_DESCRIPTION,
	buildAskUserResultMessage,
} from "./prompt.ts";

const ASK_USER_TOOL_NAME = "ask_user";
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

type QuestionType = "single" | "multi" | "text";

const OptionSchema = Type.Object({
	value: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionValue }),
	label: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel }),
	description: Type.Optional(Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription })),
	recommended: Type.Optional(Type.Boolean({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionRecommended })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.id }),
	header: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.header, maxLength: 24 }),
	question: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.question }),
	type: Type.String({
		description: ASK_USER_PARAMETER_DESCRIPTIONS.type,
		enum: ["single", "multi", "text"],
	}),
	context: Type.Optional(Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.context })),
	options: Type.Optional(Type.Array(OptionSchema, {
		description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
	})),
	allowOther: Type.Optional(Type.Boolean({ description: ASK_USER_PARAMETER_DESCRIPTIONS.allowOther })),
	placeholder: Type.Optional(Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.placeholder })),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
		minItems: MIN_QUESTIONS,
		maxItems: MAX_QUESTIONS,
	}),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	recommended: boolean;
	isOther?: boolean;
}

interface Question {
	id: string;
	header: string;
	question: string;
	type: QuestionType;
	context?: string;
	options: QuestionOption[];
	allowOther: boolean;
	placeholder?: string;
}

interface Answer {
	questionId: string;
	type: QuestionType;
	selectedValues: string[];
	selectedLabels: string[];
	customText?: string;
}

interface AskUserDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

type FormResult = { answers: Answer[]; cancelled: boolean };
type EditMode = { questionId: string; kind: "text" | "other" } | null;

function normalizeQuestions(input: AskUserInput): Question[] {
	if (input.questions.length < MIN_QUESTIONS || input.questions.length > MAX_QUESTIONS) {
		throw new Error(`ask_user requires ${MIN_QUESTIONS}-${MAX_QUESTIONS} questions`);
	}

	const ids = new Set<string>();
	return input.questions.map((raw, questionIndex) => {
		const id = raw.id.trim();
		const header = raw.header.trim();
		const question = raw.question.trim();
		const type = raw.type as QuestionType;
		const path = `questions[${questionIndex}]`;
		if (!id) throw new Error(`${path}.id must not be empty`);
		if (ids.has(id)) throw new Error(`${path}.id must be unique (duplicate: ${id})`);
		ids.add(id);
		if (!header) throw new Error(`${path}.header must not be empty`);
		if (!question) throw new Error(`${path}.question must not be empty`);
		if (!(["single", "multi", "text"] as string[]).includes(type)) {
			throw new Error(`${path}.type must be single, multi, or text`);
		}

		const rawOptions = raw.options ?? [];
		if (type === "text" && rawOptions.length > 0) {
			throw new Error(`${path}.options must be omitted for text questions`);
		}
		if (type !== "text" && (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS)) {
			throw new Error(`${path}.options requires ${MIN_OPTIONS}-${MAX_OPTIONS} choices`);
		}

		const values = new Set<string>();
		const options = rawOptions.map((rawOption, optionIndex) => {
			const value = rawOption.value.trim();
			const label = rawOption.label.trim();
			const optionPath = `${path}.options[${optionIndex}]`;
			if (!value) throw new Error(`${optionPath}.value must not be empty`);
			if (values.has(value)) throw new Error(`${optionPath}.value must be unique (duplicate: ${value})`);
			values.add(value);
			if (!label) throw new Error(`${optionPath}.label must not be empty`);
			return {
				value,
				label,
				description: rawOption.description?.trim() || undefined,
				recommended: rawOption.recommended === true,
			};
		});

		return {
			id,
			header,
			question,
			type,
			context: raw.context?.trim() || undefined,
			options,
			allowOther: type !== "text" && raw.allowOther !== false,
			placeholder: raw.placeholder?.trim() || undefined,
		};
	});
}

function answerMap(answers: Answer[]) {
	return Object.fromEntries(answers.map((answer) => [answer.questionId, {
		type: answer.type,
		selectedValues: answer.selectedValues,
		selectedLabels: answer.selectedLabels,
		...(answer.customText ? { customText: answer.customText } : {}),
	}]));
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool(withStatusCard({
		name: ASK_USER_TOOL_NAME,
		label: "Ask User",
		description: ASK_USER_TOOL_DESCRIPTION,
		promptSnippet: ASK_USER_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params);
			const reply = (text: string, answers: Answer[] = [], cancelled = false) => ({
				content: [{ type: "text" as const, text }],
				details: { questions, answers, cancelled } satisfies AskUserDetails,
			});

			if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
				return reply(buildAskUserResultMessage({ kind: "no-ui" }), [], true);
			}
			if (signal?.aborted) return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], true);

			const uiSignal = signal ?? new AbortController().signal;
			const result = await ctx.ui.custom<FormResult>((tui, theme, _keybindings, done) => {
				const answers = new Map<string, Answer>();
				let currentTab = 0;
				let optionIndex = 0;
				let editMode: EditMode = null;
				let cachedLines: string[] | undefined;
				let settled = false;

				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function finish(formResult: FormResult) {
					if (settled) return;
					settled = true;
					uiSignal.removeEventListener("abort", cancel);
					done(formResult);
				}

				function cancel() {
					finish({ answers: [], cancelled: true });
				}

				uiSignal.addEventListener("abort", cancel, { once: true });
				if (uiSignal.aborted) queueMicrotask(cancel);

				function currentQuestion() {
					return questions[currentTab];
				}

				function displayOptions(question: Question): QuestionOption[] {
					return question.allowOther
						? [...question.options, {
							value: "__other__",
							label: "Write my own answer…",
							recommended: false,
							isOther: true,
						}]
						: question.options;
				}

				function allAnswered() {
					return questions.every((question) => answers.has(question.id));
				}

				function goToTab(index: number) {
					editMode = null;
					editor.setText("");
					currentTab = (index + questions.length + 1) % (questions.length + 1);
					optionIndex = 0;
					refresh();
				}

				function advance() {
					goToTab(Math.min(currentTab + 1, questions.length));
				}

				function startEditor(question: Question, kind: "text" | "other") {
					editMode = { questionId: question.id, kind };
					editor.setText(answers.get(question.id)?.customText ?? "");
					refresh();
				}

				function setSingleAnswer(question: Question, option: QuestionOption) {
					answers.set(question.id, {
						questionId: question.id,
						type: question.type,
						selectedValues: [option.value],
						selectedLabels: [option.label],
					});
					advance();
				}

				function toggleMultiAnswer(question: Question, option: QuestionOption) {
					const existing = answers.get(question.id);
					const selectedValues = [...(existing?.selectedValues ?? [])];
					const selectedLabels = [...(existing?.selectedLabels ?? [])];
					const selectedIndex = selectedValues.indexOf(option.value);
					if (selectedIndex >= 0) {
						selectedValues.splice(selectedIndex, 1);
						selectedLabels.splice(selectedIndex, 1);
					} else {
						selectedValues.push(option.value);
						selectedLabels.push(option.label);
					}
					if (selectedValues.length === 0 && !existing?.customText) {
						answers.delete(question.id);
					} else {
						answers.set(question.id, {
							questionId: question.id,
							type: "multi",
							selectedValues,
							selectedLabels,
							...(existing?.customText ? { customText: existing.customText } : {}),
						});
					}
					refresh();
				}

				editor.onSubmit = (value) => {
					if (!editMode) return;
					const question = questions.find((candidate) => candidate.id === editMode?.questionId);
					if (!question) return;
					const customText = value.trim();
					const existing = answers.get(question.id);
					if (!customText) {
						if (question.type === "multi" && existing?.selectedValues.length) {
							answers.set(question.id, { ...existing, customText: undefined });
						} else {
							answers.delete(question.id);
						}
						editMode = null;
						editor.setText("");
						refresh();
						return;
					}
					answers.set(question.id, {
						questionId: question.id,
						type: question.type,
						selectedValues: question.type === "multi" ? existing?.selectedValues ?? [] : [],
						selectedLabels: question.type === "multi" ? existing?.selectedLabels ?? [] : [],
						customText,
					});
					editMode = null;
					editor.setText("");
					advance();
				};

				function selectAt(index: number) {
					const question = currentQuestion();
					if (!question || question.type === "text") return;
					const option = displayOptions(question)[index];
					if (!option) return;
					optionIndex = index;
					if (option.isOther) {
						startEditor(question, "other");
					} else if (question.type === "single") {
						setSingleAnswer(question, option);
					} else {
						toggleMultiAnswer(question, option);
					}
				}

				function handleInput(data: string) {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						goToTab(currentTab + 1);
						return;
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						goToTab(currentTab - 1);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						finish({ answers: [], cancelled: true });
						return;
					}

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							finish({
								answers: questions.map((question) => answers.get(question.id)).filter(Boolean) as Answer[],
								cancelled: false,
							});
						}
						return;
					}

					const question = currentQuestion();
					if (!question) return;
					const options = displayOptions(question);
					if (question.type !== "text" && matchesKey(data, Key.up)) {
						optionIndex = (optionIndex - 1 + options.length) % options.length;
						refresh();
						return;
					}
					if (question.type !== "text" && matchesKey(data, Key.down)) {
						optionIndex = (optionIndex + 1) % options.length;
						refresh();
						return;
					}
					if (question.type !== "text" && data.length === 1 && data >= "1" && data <= "9") {
						selectAt(Number(data) - 1);
						return;
					}
					if (question.type === "multi" && (matchesKey(data, Key.space) || data === " ")) {
						selectAt(optionIndex);
						return;
					}
					if (matchesKey(data, Key.enter)) {
						if (question.type === "text") {
							startEditor(question, "text");
						} else if (question.type === "multi" && answers.has(question.id) && !options[optionIndex]?.isOther) {
							advance();
						} else {
							selectAt(optionIndex);
						}
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const question = currentQuestion();

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
						for (let index = 0; index < wrapped.length; index++) {
							lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
						}
					}

					addWrapped(theme.fg("accent", "─".repeat(renderWidth)));
					const tabs = questions.map((candidate, index) => {
						const answered = answers.has(candidate.id);
						const label = ` ${answered ? "■" : "□"} ${candidate.header} `;
						return index === currentTab
							? theme.bg("selectedBg", theme.fg("text", label))
							: theme.fg(answered ? "success" : "muted", label);
					});
					const reviewLabel = " ✓ Review ";
					tabs.push(currentTab === questions.length
						? theme.bg("selectedBg", theme.fg("text", reviewLabel))
						: theme.fg(allAnswered() ? "success" : "dim", reviewLabel));
					addWrappedWithPrefix(" ", tabs.join(" "));
					lines.push("");

					if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review answers")));
						lines.push("");
						for (const candidate of questions) {
							const answer = answers.get(candidate.id);
							const values = answer
								? [...answer.selectedLabels, ...(answer.customText ? [answer.customText] : [])].join(", ")
								: "Unanswered";
							addWrappedWithPrefix(" ", `${theme.fg("muted", `${candidate.header}: `)}${theme.fg(answer ? "text" : "warning", values)}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg(allAnswered() ? "success" : "warning",
							allAnswered() ? "Press Enter to submit" : "Answer every question before submitting"));
					} else if (question) {
						addWrappedWithPrefix(" ", theme.fg("text", theme.bold(question.question)));
						if (question.context) {
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", question.context));
						}
						lines.push("");

						if (question.type === "text") {
							const saved = answers.get(question.id)?.customText;
							addWrappedWithPrefix(" ❯ ", theme.fg("accent", saved ?? question.placeholder ?? "Write an answer…"));
						} else {
							const saved = answers.get(question.id);
							for (const [index, option] of displayOptions(question).entries()) {
								const focused = index === optionIndex;
								const selected = option.isOther
									? Boolean(saved?.customText)
									: saved?.selectedValues.includes(option.value) === true;
								const marker = question.type === "multi" ? (selected ? "[x]" : "[ ]") : (selected ? "(●)" : "( )");
								const prefix = focused ? theme.fg("accent", " ❯ ") : "   ";
								const recommendation = option.recommended ? theme.fg("warning", " (recommended)") : "";
								const custom = option.isOther && saved?.customText ? `: ${saved.customText}` : "";
								addWrappedWithPrefix(prefix, theme.fg(focused ? "accent" : "text", `${index + 1}. ${marker} ${option.label}${custom}`) + recommendation);
								if (option.description) addWrappedWithPrefix("       ", theme.fg("muted", option.description));
							}
						}

						if (editMode) {
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", editMode.kind === "text" ? "Your answer:" : "Custom answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
						}
					}

					lines.push("");
					const help = editMode
						? "Enter save • Esc back"
						: question?.type === "multi"
							? "↑↓ move • Space toggle • Enter next • Tab/←→ questions • Esc cancel"
							: "↑↓ move • Enter choose/edit • Tab/←→ questions • Esc cancel";
					addWrappedWithPrefix(" ", theme.fg("dim", help));
					addWrapped(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => { cachedLines = undefined; },
					handleInput,
					dispose: () => uiSignal.removeEventListener("abort", cancel),
				};
			});

			if (signal?.aborted) return reply(buildAskUserResultMessage({ kind: "cancelled" }), [], true);
			if (result.cancelled) return reply(buildAskUserResultMessage({ kind: "dismissed" }), [], true);
			return reply(
				buildAskUserResultMessage({ kind: "submitted", answers: answerMap(result.answers) }),
				result.answers,
				false,
			);
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions as Array<{ header?: string; id?: string }> : [];
			const labels = questions.map((question) => question.header || question.id).filter(Boolean).join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${labels})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
			const lines = details.answers.map((answer) => {
				const values = [...answer.selectedLabels, ...(answer.customText ? [answer.customText] : [])].join(", ");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.questionId)}: ${theme.fg("text", values)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	}));
}
