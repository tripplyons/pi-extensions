import { describe, expect, test } from "bun:test";
import {
	collapseThinkingBlocks,
	installThinkingCounter,
	type MessageLike,
	type ThinkingComponentLike,
	type ThinkingComponentPrototype,
} from "./logic.ts";

const message = (...content: MessageLike["content"]): MessageLike => ({ content });

describe("collapseThinkingBlocks", () => {
	test("merges one consecutive thinking run and reports its count", () => {
		const original = message(
			{ type: "thinking", thinking: "first" },
			{ type: "thinking", thinking: "second" },
			{ type: "text", text: "answer" },
		);

		const collapsed = collapseThinkingBlocks(original);

		expect(collapsed.count).toBe(2);
		expect(collapsed.message.content).toEqual([
			{ type: "thinking", thinking: "first\n\nsecond" },
			{ type: "text", text: "answer" },
		]);
		expect(original.content).toHaveLength(3);
	});

	test("leaves separated thinking blocks unchanged", () => {
		const original = message(
			{ type: "thinking", thinking: "first" },
			{ type: "text", text: "middle" },
			{ type: "thinking", thinking: "second" },
		);

		const collapsed = collapseThinkingBlocks(original);

		expect(collapsed.count).toBe(0);
		expect(collapsed.message).toBe(original);
	});

	test("collapses thinking blocks separated only by hidden tool calls", () => {
		const original = message(
			{ type: "thinking", thinking: "first" },
			{ type: "toolCall", name: "read" },
			{ type: "thinking", thinking: "second" },
		);

		const collapsed = collapseThinkingBlocks(original);

		expect(collapsed.count).toBe(2);
		expect(collapsed.message.content).toEqual([
			{ type: "thinking", thinking: "first\n\nsecond" },
			{ type: "toolCall", name: "read" },
		]);
	});
});

describe("installThinkingCounter", () => {
	test("renders a counted hidden label while preserving the original message", () => {
		const renders: Array<{ label: string; message: MessageLike }> = [];
		const original = function(this: ThinkingComponentLike, renderedMessage: MessageLike) {
			renders.push({ label: this.hiddenThinkingLabel, message: renderedMessage });
			this.lastMessage = renderedMessage;
		};
		const prototype: ThinkingComponentPrototype = { updateContent: original };
		const restore = installThinkingCounter(prototype);
		const component: ThinkingComponentLike = {
			hideThinkingBlock: true,
			hiddenThinkingLabel: "Thinking...",
		};
		const originalMessage = message(
			{ type: "thinking", thinking: "first" },
			{ type: "thinking", thinking: "second" },
		);

		prototype.updateContent.call(component, originalMessage);

		expect(renders[0].label).toBe("Thinking... (x2)");
		expect(renders[0].message.content).toHaveLength(1);
		expect(component.hiddenThinkingLabel).toBe("Thinking...");
		expect(component.lastMessage).toBe(originalMessage);

		restore();
		expect(prototype.updateContent).toBe(original);
	});

	test("does not alter visible thinking blocks", () => {
		let renderedMessage: MessageLike | undefined;
		const prototype: ThinkingComponentPrototype = {
			updateContent(message) { renderedMessage = message; },
		};
		installThinkingCounter(prototype);
		const component: ThinkingComponentLike = {
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
		};
		const originalMessage = message(
			{ type: "thinking", thinking: "first" },
			{ type: "thinking", thinking: "second" },
		);

		prototype.updateContent.call(component, originalMessage);

		expect(renderedMessage).toBe(originalMessage);
	});
});
