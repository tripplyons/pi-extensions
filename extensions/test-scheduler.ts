import type { ScheduledTask, Scheduler } from "./scheduler.ts";

interface PendingTask {
	id: number;
	dueAt: number;
	intervalMs?: number;
	callback: () => void | Promise<void>;
}

export class ManualScheduler implements Scheduler {
	#nextId = 1;
	#now = 0;
	#tasks = new Map<number, PendingTask>();

	get now(): number { return this.#now; }
	get pending(): number { return this.#tasks.size; }
	time(): number { return this.#now; }

	after(delayMs: number, callback: () => void | Promise<void>): ScheduledTask {
		return this.#add(delayMs, undefined, callback);
	}

	every(delayMs: number, callback: () => void | Promise<void>): ScheduledTask {
		if (delayMs <= 0) throw new Error("Manual scheduler intervals must be positive");
		return this.#add(delayMs, delayMs, callback);
	}

	cancel(task: ScheduledTask): void {
		this.#tasks.delete(task as unknown as number);
	}

	async advanceBy(delayMs: number): Promise<void> {
		if (delayMs < 0) throw new Error("Cannot move the manual scheduler backwards");
		const target = this.#now + delayMs;
		while (true) {
			const task = [...this.#tasks.values()]
				.filter(candidate => candidate.dueAt <= target)
				.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
			if (!task) break;
			this.#now = task.dueAt;
			if (task.intervalMs === undefined) this.#tasks.delete(task.id);
			else task.dueAt += task.intervalMs;
			await task.callback();
			await Promise.resolve();
		}
		this.#now = target;
		await Promise.resolve();
	}

	async runNext(): Promise<boolean> {
		const next = [...this.#tasks.values()].sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
		if (!next) return false;
		await this.advanceBy(next.dueAt - this.#now);
		return true;
	}

	#add(delayMs: number, intervalMs: number | undefined, callback: () => void | Promise<void>): ScheduledTask {
		if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("Invalid scheduler delay");
		const id = this.#nextId++;
		this.#tasks.set(id, { id, dueAt: this.#now + delayMs, intervalMs, callback });
		return id as unknown as ScheduledTask;
	}
}
