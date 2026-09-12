export const ASYNC_JOB_COMPLETED_EVENT = "tripp:async-job-completed";

export interface AsyncJobCompletedEvent {
	source: "subagent" | "mixture";
	id: string;
	status: "exited" | "failed" | "killed";
}

export const isAsyncJobCompletedEvent = (value: unknown): value is AsyncJobCompletedEvent => {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<AsyncJobCompletedEvent>;
	return (event.source === "subagent" || event.source === "mixture")
		&& typeof event.id === "string"
		&& (event.status === "exited" || event.status === "failed" || event.status === "killed");
};
