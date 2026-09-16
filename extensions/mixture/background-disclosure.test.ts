import { expect, test } from "bun:test";
import { backgroundDetachWarning } from "./index.ts";

const jobs = (values: Array<{ id: string; status: "running" | "exited" | "killed" }>, error?: string) => ({
	sessionId: "fixture", available: true, error,
	jobs: values.map(job => ({ ...job, cwd: "/fixture", ownerSessionId: "fixture" })),
});

test("leaving Mixture discloses surviving tracked jobs without claiming to stop them", () => {
	expect(backgroundDetachWarning(jobs([
		{ id: "job-running", status: "running" },
		{ id: "job-finished", status: "exited" },
	]))).toBe("Mixture stopped inference, not shell jobs. Still running: job-running");
	expect(backgroundDetachWarning(jobs([{ id: "job-finished", status: "exited" }]))).toBeUndefined();
});

test("background query failures remain visible during detach", () => {
	expect(backgroundDetachWarning(jobs([], "background manager unavailable")))
		.toBe("Mixture stopped inference, not shell jobs. background manager unavailable");
});
