export type ScheduledTask = ReturnType<typeof setTimeout>;

export interface Scheduler {
	after(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
	every(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
	cancel(task: ScheduledTask): void;
}

export const systemScheduler: Scheduler = {
	after: (delayMs, callback) => setTimeout(() => void callback(), delayMs),
	every: (delayMs, callback) => setInterval(() => void callback(), delayMs),
	cancel: (task) => {
		clearTimeout(task);
		clearInterval(task);
	},
};
