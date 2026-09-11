import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "../agent-swarm/state.ts";
import { stateHome, type RunOptions, type WorkerUsage } from "./runner.ts";

export { readJson, writeJson };

export type Status = "queued" | "running" | "stopping" | "ok" | "failed" | "timeout" | "stopped";

export interface Attempt {
	attempt: number;
	status: Status;
	startedAt: number;
	finishedAt?: number;
	pid?: number;
	output: string;
	error?: string;
	usage: WorkerUsage;
	logFile: string;
	sessionFile: string;
}

export interface Worker {
	id: string;
	model: string;
	cwd: string;
	branch?: string;
	gitRoot?: string;
	gitCommonDir?: string;
	changes?: string;
	attempts: Attempt[];
}

export interface Run {
	schemaVersion: 1;
	id: string;
	ownerSession: string;
	createdAt: number;
	updatedAt: number;
	supervisorPid: number;
	options: RunOptions;
	workers: Worker[];
	commands: CommandResult[];
}

export interface Command {
	id: string;
	session: string;
	action: "send" | "stop" | "restart" | "resume";
	workerId?: string;
	message?: string;
	createdAt: number;
}

export interface CommandResult extends Command {
	status: "accepted" | "rejected" | "pending";
	error?: string;
}

export const newRunId = () => `mix_${randomUUID().replaceAll("-", "")}`;
export const newCommandId = () => `cmd_${randomUUID().replaceAll("-", "")}`;
export const runDir = (id: string) => {
	if (!/^mix_[a-zA-Z0-9_]+$/.test(id)) throw new Error("Invalid mixture run ID");
	return join(stateHome(), "runs", id);
};
export const runFile = (id: string) => join(runDir(id), "run.json");
export const readRun = (id: string): Run => {
	const run = readJson<Run>(runFile(id));
	if (!run || run.schemaVersion !== 1 || run.id !== id) throw new Error(`Invalid mixture run: ${id}`);
	return run;
};
export const saveRun = (run: Run) => {
	run.updatedAt = Date.now();
	writeJson(runFile(run.id), run);
};
export const currentAttempt = (worker: Worker) => worker.attempts[worker.attempts.length - 1];
export const terminal = (status: Status) => !["queued", "running", "stopping"].includes(status);
export const emptyUsage = (): WorkerUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
