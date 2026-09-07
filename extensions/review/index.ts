import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const REVIEW_TOOL_NAMES = [
	"bash",
	"write",
	"edit",
	"code",
	"exec",
	"headless_ui",
] as const;
const REVIEW_TOOLS: ReadonlySet<string> = new Set(REVIEW_TOOL_NAMES);
const CUSTOM_TYPE = "review-state";
const BLOCK_LIMIT = 1200;
const APPROVAL_PROMPT = "Review requested";
const APPROVAL_PLACEHOLDER = "Press Enter to approve, or type feedback to deny";

export type ReviewToolName = typeof REVIEW_TOOL_NAMES[number];
type StoredEntry = {
	type?: string;
	customType?: string;
	data?: { enabled?: unknown };
};
export type ReviewCall = { id: string; name: ReviewToolName };
type ReviewBatch = {
	calls: ReviewCall[];
	handledCallIds: Set<string>;
	feedbackPromise?: Promise<string | undefined>;
};

const truncate = (text: string, limit: number) => text.length <= limit
	? text
	: `${text.slice(0, limit)}\n… truncated ${text.length - limit} character(s)`;

const APPROVAL_LABELS: Record<ReviewToolName, string> = {
	bash: "Bash",
	write: "Write",
	edit: "Edit",
	code: "Code Program",
	exec: "Exec Cell",
	headless_ui: "Headless UI",
};

export const approvalCallSummary = (call: ReviewCall) => APPROVAL_LABELS[call.name];

const approvalPrompt = (calls: ReviewCall[]) => [
	APPROVAL_PROMPT,
	...calls.flatMap((call, index) => [
		"",
		calls.length > 1 ? `${index + 1}. ${approvalCallSummary(call)}` : approvalCallSummary(call),
	]),
	"",
	APPROVAL_PLACEHOLDER,
].join("\n");

const buildDeniedReason = (toolName: ReviewToolName, feedback: string | undefined) => {
	const note = feedback?.trim() || "User denied the tool call and did not provide additional feedback.";
	return truncate(`Review denied ${toolName}.\nUser feedback: ${note}`, BLOCK_LIMIT);
};

export const isReviewToolName = (toolName: unknown): toolName is ReviewToolName =>
	typeof toolName === "string" && REVIEW_TOOLS.has(toolName);

export const reviewCallsFromMessage = (message: { role?: unknown; content?: unknown }): ReviewCall[] => {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => {
		if (!block || typeof block !== "object") return [];
		const toolCall = block as { type?: unknown; id?: unknown; name?: unknown };
		if (toolCall.type !== "toolCall" || typeof toolCall.id !== "string" || !isReviewToolName(toolCall.name)) return [];
		return [{ id: toolCall.id, name: toolCall.name }];
	});
};

const readStoredEnabled = (entries: StoredEntry[]) => {
	let enabled = false;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && typeof entry.data?.enabled === "boolean") {
			enabled = entry.data.enabled;
		}
	}
	return enabled;
};

export default function reviewExtension(pi: ExtensionAPI) {
	let enabled = false;
	let pendingBatches: ReviewBatch[] = [];

	const setStatus = (ctx: ExtensionContext) => {
		const value = enabled ? "on" : "off";
		ctx.ui.setStatus("review", ctx.ui.theme.fg("dim", "review ") + ctx.ui.theme.fg("accent", value));
	};

	const findBatch = (toolCallId: string) => pendingBatches.find((batch) =>
		batch.calls.some((call) => call.id === toolCallId));

	const getBatchFeedback = (batch: ReviewBatch, ctx: ExtensionContext) => {
		batch.feedbackPromise ??= ctx.ui.input(approvalPrompt(batch.calls), APPROVAL_PLACEHOLDER);
		return batch.feedbackPromise;
	};

	const markBatchHandled = (batch: ReviewBatch, toolCallId: string) => {
		batch.handledCallIds.add(toolCallId);
		if (batch.handledCallIds.size === batch.calls.length) {
			pendingBatches = pendingBatches.filter((pendingBatch) => pendingBatch !== batch);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		enabled = readStoredEnabled(ctx.sessionManager.getEntries() as StoredEntry[]);
		pendingBatches = [];
		setStatus(ctx);
	});

	pi.on("message_end", (event) => {
		if (!enabled) return;
		const calls = reviewCallsFromMessage(event.message as { role?: unknown; content?: unknown });
		if (calls.length) pendingBatches.push({ calls, handledCallIds: new Set() });
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || !isReviewToolName(event.toolName)) return undefined;
		const batch = findBatch(event.toolCallId);
		if (!ctx.hasUI) {
			if (batch) markBatchHandled(batch, event.toolCallId);
			return { block: true, reason: `Review mode blocked ${event.toolName}: interactive approval UI is unavailable.` };
		}

		let feedback: string | undefined;
		try {
			feedback = batch
				? await getBatchFeedback(batch, ctx)
				: await ctx.ui.input(
					approvalPrompt([{ id: event.toolCallId, name: event.toolName }]),
					APPROVAL_PLACEHOLDER,
				);
		} finally {
			if (batch) markBatchHandled(batch, event.toolCallId);
		}

		if (feedback !== undefined && feedback.trim() === "") return undefined;
		return { block: true, reason: buildDeniedReason(event.toolName, feedback) };
	});

	pi.registerCommand("review", {
		description: "Toggle approval review for bash, write/edit, code/exec, and headless computer-use tool calls (on, off, toggle)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action === "" || action === "toggle") enabled = !enabled;
			else {
				ctx.ui.notify("Usage: /review [on|off|toggle]", "warning");
				return;
			}

			pi.appendEntry(CUSTOM_TYPE, { enabled });
			setStatus(ctx);
			ctx.ui.notify(`Review mode ${enabled ? "on" : "off"} for this session`, "info");
		},
	});
}
