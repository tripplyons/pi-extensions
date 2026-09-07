export interface TranscriptItem {
	role?: string;
	type?: string;
	[key: string]: unknown;
}

interface RenderOptions {
	populateHistory?: boolean;
	updateFooter?: boolean;
}

interface MessageWindowEvent {
	type: string;
	message?: TranscriptItem;
}

interface InteractiveModeLike {
	chatContainer: { clear(): void };
	editor: { addToHistory?(text: string): void };
	sessionManager: { buildContextEntries(): unknown[] };
	getUserMessageText(message: TranscriptItem): string;
	renderSessionEntries(entries: unknown[], options?: RenderOptions): void;
}

export interface InteractiveModePrototype {
	renderSessionItems(this: InteractiveModeLike, items: TranscriptItem[], options?: RenderOptions): void;
	handleEvent(this: InteractiveModeLike, event: MessageWindowEvent): Promise<void>;
}

const countsTowardLimit = (item: TranscriptItem) =>
	(item.role !== undefined && item.role !== "toolResult") || item.type === "custom";

export const windowTranscriptItems = (items: TranscriptItem[], maxMessages: number) => {
	const visibleIndexes = items.flatMap((item, index) => countsTowardLimit(item) ? [index] : []);
	const hiddenMessages = Math.max(0, visibleIndexes.length - maxMessages);
	if (hiddenMessages === 0) return { items, hiddenMessages };
	if (maxMessages === 0) return { items: [], hiddenMessages };

	const firstVisibleIndex = visibleIndexes[hiddenMessages]!;
	return { items: items.slice(firstVisibleIndex), hiddenMessages };
};

const isConversationEvent = (event: MessageWindowEvent, phase: "message_start" | "message_end") =>
	event.type === phase && (event.message?.role === "user" || event.message?.role === "assistant");

export const installMessageWindow = (prototype: InteractiveModePrototype, maxMessages: number) => {
	if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("Message window size must be a positive integer.");

	const originalRenderSessionItems = prototype.renderSessionItems;
	const originalHandleEvent = prototype.handleEvent;
	const reservedSlots = new WeakMap<InteractiveModeLike, number>();

	const patchedRenderSessionItems = function(this: InteractiveModeLike, items: TranscriptItem[], options: RenderOptions = {}) {
		if (options.populateHistory) {
			for (const item of items) {
				if (item.role !== "user") continue;
				const text = this.getUserMessageText(item);
				if (text) this.editor.addToHistory?.(text);
			}
		}

		const availableMessages = maxMessages - (reservedSlots.get(this) ?? 0);
		const windowed = windowTranscriptItems(items, availableMessages).items;
		originalRenderSessionItems.call(this, windowed, { ...options, populateHistory: false });
	};

	const rebuildWindow = (mode: InteractiveModeLike) => {
		mode.chatContainer.clear();
		mode.renderSessionEntries(mode.sessionManager.buildContextEntries());
	};

	const patchedHandleEvent = async function(this: InteractiveModeLike, event: MessageWindowEvent) {
		if (isConversationEvent(event, "message_start")) {
			reservedSlots.set(this, 1);
			rebuildWindow(this);
		}

		await originalHandleEvent.call(this, event);

		if (isConversationEvent(event, "message_end")) {
			reservedSlots.delete(this);
		}
	};

	prototype.renderSessionItems = patchedRenderSessionItems;
	prototype.handleEvent = patchedHandleEvent;

	return () => {
		if (prototype.renderSessionItems === patchedRenderSessionItems) prototype.renderSessionItems = originalRenderSessionItems;
		if (prototype.handleEvent === patchedHandleEvent) prototype.handleEvent = originalHandleEvent;
	};
};
