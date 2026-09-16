export type ScheduledTask = ReturnType<typeof setTimeout>;

export interface Scheduler {
	after(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
	every(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
	cancel(task: ScheduledTask): void;
}

export const systemScheduler: Scheduler = {
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
