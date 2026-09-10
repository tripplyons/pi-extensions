import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workerHome } from "./state.ts";
import type { NodeRecord, NodeStatus, Role, RunRecord } from "./types.ts";

type Entry = Record<string, any>;

export const sessionCost = (entries: Entry[]) => entries.reduce((total, entry) => {
	let usage: any;
	if (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role)) usage = entry.message.usage;
	if (["compaction", "branch_summary"].includes(entry.type)) usage = entry.usage;
	const cost = usage?.cost?.total;
	return total + (typeof cost === "number" && Number.isFinite(cost) ? cost : 0);
}, 0);

const jsonlFiles = (directory: string): string[] => {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return jsonlFiles(path);
		return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
	});
};

const readJsonl = (path: string) => {
	const body = readFileSync(path, "utf8");
	const lines = body.split("\n");
	return lines.flatMap((line, index) => {
		if (!line.trim()) return [];
		try { return [JSON.parse(line)]; }
		catch (error) {
			if (index === lines.length - 1 && !body.endsWith("\n")) return [];
			throw new Error(`Invalid worker session entry in ${path}: ${error}`);
		}
	});
};

export const workerCost = (node: NodeRecord) => {
	const directory = join(workerHome(node.runId, node.nodeId), ".pi", "agent", "sessions");
	if (!existsSync(directory)) return node.estimatedCost ?? 0;
	return sessionCost(jsonlFiles(directory).flatMap(readJsonl));
};

const elapsed = (milliseconds: number) => {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const parts = [];
	if (hours) parts.push(`${hours}h`);
	if (minutes % 60) parts.push(`${minutes % 60}m`);
	parts.push(`${seconds % 60}s`);
	return parts.join(" ");
};

const lifecycleOrder: NodeStatus[] = ["starting", "running", "awaiting-review", "rework", "completed", "rejected", "failed", "stopped"];
const roleOrder: Array<Exclude<Role, "coordinator">> = ["manager", "worker", "reviewer"];
const counts = <T extends string>(values: T[], order: T[]) => order.flatMap((value) => {
	const count = values.filter((item) => item === value).length;
	return count ? [`${value.replaceAll("-", " ")} ${count}`] : [];
});

export const formatSwarmStatus = (run: RunRecord, nodes: NodeRecord[], pendingMessages: number, estimatedCost: number, timestamp = Date.now()) => {
	const workers = nodes.filter((node) => node.role !== "coordinator");
	const end = run.status === "stopped" ? run.updatedAt : timestamp;
	return [
		`Swarm: ${run.status} · ${elapsed(end - run.createdAt)}`,
		`Nodes: ${workers.length}${counts(workers.map((node) => node.status), lifecycleOrder).map((part) => ` · ${part}`).join("")}`,
		`Roles: ${counts(workers.map((node) => node.role as Exclude<Role, "coordinator">), roleOrder).join(" · ") || "none"}`,
		`Coordinator inbox: ${pendingMessages}`,
		`Estimated cost: $${estimatedCost.toFixed(3)}`,
	].join("\n");
};
