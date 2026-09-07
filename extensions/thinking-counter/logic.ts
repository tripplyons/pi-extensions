interface ContentBlock {
	type: string;
	thinking?: string;
	text?: string;
	[key: string]: unknown;
}

export interface MessageLike {
	content: ContentBlock[];
	[key: string]: unknown;
}

export interface ThinkingComponentLike {
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	lastMessage?: MessageLike;
}

export interface ThinkingComponentPrototype {
	updateContent(this: ThinkingComponentLike, message: MessageLike): void;
}

export const collapseThinkingBlocks = (message: MessageLike) => {
	const thinkingIndexes = message.content
		.map((block, index) => block.type === "thinking" && block.thinking?.trim() ? index : -1)
		.filter((index) => index >= 0);

	if (thinkingIndexes.length < 2) return { message, count: thinkingIndexes.length };

	const start = thinkingIndexes[0]!;
	const end = thinkingIndexes[thinkingIndexes.length - 1]!;
	const visibleTextBetween = message.content
		.slice(start + 1, end)
		.some((block) => block.type === "text" && block.text?.trim());
	if (visibleTextBetween) return { message, count: 0 };

	const merged = {
		...message.content[start],
		thinking: thinkingIndexes.map((index) => message.content[index]!.thinking?.trim()).join("\n\n"),
	};
	const removedIndexes = new Set(thinkingIndexes.slice(1));
	const content = message.content.flatMap((block, index) => {
		if (index === start) return [merged];
		if (removedIndexes.has(index)) return [];
		return [block];
	});

	return {
		message: {
			...message,
			content,
		},
		count: thinkingIndexes.length,
	};
};

export const installThinkingCounter = (prototype: ThinkingComponentPrototype) => {
	const original = prototype.updateContent;
	const patched = function(this: ThinkingComponentLike, message: MessageLike) {
		if (!this.hideThinkingBlock) {
			original.call(this, message);
			return;
		}

		const collapsed = collapseThinkingBlocks(message);
		if (collapsed.count < 2) {
			original.call(this, message);
			return;
		}

		const label = this.hiddenThinkingLabel;
		try {
			this.hiddenThinkingLabel = `${label} (x${collapsed.count})`;
			original.call(this, collapsed.message);
			this.lastMessage = message;
		} finally {
			this.hiddenThinkingLabel = label;
		}
	};

	prototype.updateContent = patched;
	return () => {
		if (prototype.updateContent === patched) prototype.updateContent = original;
	};
};
