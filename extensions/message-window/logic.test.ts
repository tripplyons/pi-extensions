import { describe, expect, test } from "bun:test";
import {
	installMessageWindow,
	type InteractiveModePrototype,
	type TranscriptItem,
	windowTranscriptItems,
} from "./logic.ts";

describe("windowTranscriptItems", () => {
	test("keeps the newest visible messages and their tool results", () => {
		const items: TranscriptItem[] = [
			{ role: "user", id: "user-1" },
			{ role: "assistant", id: "assistant-1" },
			{ role: "toolResult", id: "tool-1" },
			{ role: "user", id: "user-2" },
			{ role: "assistant", id: "assistant-2" },
			{ role: "toolResult", id: "tool-2" },
		];

		const windowed = windowTranscriptItems(items, 2);

		expect(windowed.hiddenMessages).toBe(2);
		expect(windowed.items.map((item) => item.id)).toEqual(["user-2", "assistant-2", "tool-2"]);
		expect(items).toHaveLength(6);
	});

	test("can reserve the entire window for an incoming message", () => {
		const items: TranscriptItem[] = [
			{ role: "user" },
			{ role: "assistant" },
			{ role: "toolResult" },
		];

		expect(windowTranscriptItems(items, 0)).toEqual({ items: [], hiddenMessages: 2 });
	});
});

describe("installMessageWindow", () => {
	test("limits rendering without truncating editor history or source messages", async () => {
		const rendered: TranscriptItem[][] = [];
		const renderOptions: Array<{ populateHistory?: boolean }> = [];
		const handledEvents: string[] = [];
		const prototype: InteractiveModePrototype = {
			renderSessionItems(items, options = {}) {
				rendered.push(items);
				renderOptions.push(options);
			},
			async handleEvent(event) {
				handledEvents.push(event.type);
			},
		};
		const originalRender = prototype.renderSessionItems;
		const originalHandleEvent = prototype.handleEvent;
		const restore = installMessageWindow(prototype, 2);
		const entries: TranscriptItem[] = [
			{ role: "user", text: "first" },
			{ role: "assistant", text: "first reply" },
			{ role: "user", text: "second" },
			{ role: "assistant", text: "second reply" },
		];
		const history: string[] = [];
		let clearCount = 0;
		const mode = {
			chatContainer: { clear() { clearCount++; } },
			editor: { addToHistory(text: string) { history.push(text); } },
			sessionManager: { buildContextEntries: () => entries },
			getUserMessageText: (message: TranscriptItem) => message.text as string,
			renderSessionEntries(items: unknown[], options = {}) {
				prototype.renderSessionItems.call(this, items as TranscriptItem[], options);
			},
		};

		prototype.renderSessionItems.call(mode, entries, { populateHistory: true });

		expect(history).toEqual(["first", "second"]);
		expect(rendered[0].map((item) => item.text)).toEqual(["second", "second reply"]);
		expect(renderOptions[0].populateHistory).toBeFalse();
		expect(entries).toHaveLength(4);

		await prototype.handleEvent.call(mode, { type: "message_start", message: { role: "assistant" } });

		expect(clearCount).toBe(1);
		expect(rendered[1].map((item) => item.text)).toEqual(["second reply"]);
		expect(handledEvents).toEqual(["message_start"]);

		await prototype.handleEvent.call(mode, { type: "message_end", message: { role: "assistant" } });

		expect(clearCount).toBe(1);
		expect(rendered).toHaveLength(2);
		expect(handledEvents).toEqual(["message_start", "message_end"]);

		restore();
		expect(prototype.renderSessionItems).toBe(originalRender);
		expect(prototype.handleEvent).toBe(originalHandleEvent);
	});
});
