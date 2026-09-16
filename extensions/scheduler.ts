export type ScheduledTask = ReturnType<typeof setTimeout>;

export interface Scheduler {
	time(): number;
	after(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
	every(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
	cancel(task: ScheduledTask): void;
}

export function schedulerSleep(scheduler: Scheduler, delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const abort = () => { scheduler.cancel(task); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Aborted")); };
		const task = scheduler.after(delayMs, () => { signal?.removeEventListener("abort", abort); resolve(); });
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export const systemScheduler: Scheduler = {
	time: Date.now,
	after: (delayMs, callback) => {
		const task = setTimeout(() => void callback(), delayMs);
		task.unref?.();
		return task;
	},
	every: (delayMs, callback) => {
		const task = setInterval(() => void callback(), delayMs);
		task.unref?.();
		return task;
	},
	cancel: (task) => {
		clearTimeout(task);
		clearInterval(task);
	},
};
