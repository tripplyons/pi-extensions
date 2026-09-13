import { randomUUID } from "node:crypto";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { addUsage, emptyUsage } from "./provider.ts";

export interface UsageReceipt {
	id: string;
	role: string;
	model: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	timestamp: number;
	delivery: "reported" | "held" | "nested";
}
export function receipt(role: string, model: string, message: AssistantMessage, delivery: UsageReceipt["delivery"]): UsageReceipt {
	return { id: randomUUID(), role, model, usage: structuredClone(message.usage), stopReason: message.stopReason,
		timestamp: message.timestamp, delivery };
}
export type AccountedMessage = AssistantMessage & { mixtureReceiptIds?: string[] };
export function tagReceipts(message: AssistantMessage, ids: string[]): AssistantMessage {
	const tagged = message as AccountedMessage;
	tagged.mixtureReceiptIds = [...new Set([...(tagged.mixtureReceiptIds ?? []), ...ids])];
	return tagged;
}
export function receiptIds(value: unknown): string[] {
	if (!value || typeof value !== "object" || !("mixtureReceiptIds" in value)) return [];
	const ids = value.mixtureReceiptIds;
	return Array.isArray(ids) && ids.every(id => typeof id === "string") ? ids : [];
}
export function drainReceipts(receipts: UsageReceipt[]): Usage {
	const usage = emptyUsage();
	for (const receipt of receipts) if (receipt.delivery === "nested") {
		addUsage(usage, receipt.usage);
		receipt.delivery = "reported";
	}
	return usage;
}
