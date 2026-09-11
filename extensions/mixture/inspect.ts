import { currentAttempt, runFile, type Run } from "./state.ts";

export function summarizeRun(run: Run) {
	return {
		id: run.id, ownerSession: run.ownerSession, createdAt: run.createdAt,
		updatedAt: run.updatedAt, stateFile: runFile(run.id),
		workers: run.workers.map((worker) => ({
			id: worker.id, model: worker.model,
			status: currentAttempt(worker)?.status ?? "queued",
			attempt: currentAttempt(worker)?.attempt ?? 0,
		})),
	};
}

export function inspectRun(run: Run, workerId?: string) {
	const workers = workerId ? run.workers.filter((worker) => worker.id === workerId) : run.workers;
	if (!workers.length) throw new Error(`Unknown worker: ${workerId}`);
	return { ...summarizeRun(run), task: run.options.task, commands: run.commands, workers };
}

// Bound the entire response, including tasks, errors and command history.
export function renderInspection(value: unknown, stateFile: string) {
	const full = JSON.stringify(value, null, 2);
	const lines = full.split("\n");
	const buffer = Buffer.from(lines.slice(0, 1800).join("\n"));
	if (lines.length <= 1800 && buffer.length <= 45000) return full;
	const head = buffer.subarray(0, 45000).toString("utf8").replace(/\uFFFD$/, "");
	return `${head}\n\n[Truncated. Full retained state: ${stateFile}]`;
}
