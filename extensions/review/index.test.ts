import { describe, expect, test } from "bun:test";
import {
	approvalCallSummary,
	isReviewToolName,
	reviewCallsFromMessage,
	REVIEW_TOOL_NAMES,
} from "./index.ts";

describe("review-mode tools", () => {
	test("requires review for bash, write/edit, code/exec, and every headless computer-use tool", () => {
		expect(REVIEW_TOOL_NAMES).toEqual([
			"bash",
			"write",
			"edit",
			"code",
			"exec",
			"headless_ui",
		]);
		for (const toolName of REVIEW_TOOL_NAMES) expect(isReviewToolName(toolName)).toBe(true);
		expect(isReviewToolName("read")).toBe(false);
	});

	test("collects computer-use calls into the same approval batch as bash", () => {
		expect(reviewCallsFromMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "bash-1", name: "bash" },
				{ type: "toolCall", id: "find-1", name: "headless_ui" },
				{ type: "toolCall", id: "capture-1", name: "headless_ui" },
				{ type: "toolCall", id: "read-1", name: "read" },
			],
		})).toEqual([
			{ id: "bash-1", name: "bash" },
			{ id: "find-1", name: "headless_ui" },
			{ id: "capture-1", name: "headless_ui" },
		]);
	});

	test("uses readable approval labels", () => {
		expect(approvalCallSummary({ id: "1", name: "headless_ui" })).toBe("Headless UI");
		expect(approvalCallSummary({ id: "2", name: "code" })).toBe("Code Program");
		expect(approvalCallSummary({ id: "3", name: "exec" })).toBe("Exec Cell");
	});
});
