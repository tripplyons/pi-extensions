/** Model-facing descriptions and guidance for the ask_user decision form. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
	allowOther: "Whether to add a free-form custom-answer row to a choice question (default: true)",
	context: "Optional concise context or trade-off summary shown above this question",
	header: "Short tab label, ideally 12 characters or fewer",
	id: "Unique stable identifier used as the answer key",
	optionDescription: "Optional one-line consequence or trade-off shown below the label",
	optionLabel: "Short display label",
	optionRecommended: "Mark this option as recommended without selecting it for the user",
	optionValue: "Unique stable value returned for this option",
	options: "Choice options. Required for single and multi questions; omit for text questions.",
	placeholder: "Optional hint shown for a text answer",
	question: "The full question shown to the user",
	questions: "One to four related questions. Batch only questions that can be answered independently; ask dependent follow-ups later.",
	type: "Question type: single chooses one option, multi chooses any number, and text collects a free-form answer",
};

export const ASK_USER_TOOL_DESCRIPTION =
	"Collect one or more user decisions in an interactive form. Supports single-choice, multi-select, and free-text questions, optional context, recommended-option markers, custom answers, and final review. Put 1-4 related questions in one call only when they can be answered independently; if a later question depends on an earlier answer, ask it in a subsequent call. Choice questions require 2-8 options. Recommendations are advisory and never preselected. The user may cancel without answering. Invoke as `tools.ask_user(...)` in Pi.";

export const ASK_USER_PROMPT_SNIPPET =
	"Collect 1-4 related single-choice, multi-select, or free-text answers in an interactive form";

export const ASK_USER_PROMPT_GUIDELINES = [
	"Use ask_user instead of plain text when an answer can be expressed as choices or a bounded form.",
	"Batch 2-4 related questions only when they are independent and seeing them together helps the user; ask one focused question when it blocks the next question.",
	"Put a grounded recommended option first and mark it recommended; never use a recommendation to preselect an answer.",
	"Use stable question ids and option values, concise labels, and descriptions that explain material trade-offs.",
	"Use a text question for genuinely open-ended input instead of inventing arbitrary choices.",
];

export function buildAskUserResultMessage(
	outcome:
		| { kind: "no-ui" }
		| { kind: "cancelled" }
		| { kind: "dismissed" }
		| { kind: "submitted"; answers: unknown },
) {
	switch (outcome.kind) {
		case "no-ui":
			return "No interactive TUI is available, so the questions could not be shown. Ask the user in plain text instead.";
		case "cancelled":
			return "Cancelled";
		case "dismissed":
			return "User dismissed the form without submitting. Do not assume any answer; proceed accordingly or ask differently.";
		case "submitted":
			return `User submitted answers:\n${JSON.stringify(outcome.answers, null, 2)}`;
	}
}
