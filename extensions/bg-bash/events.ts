import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BG_JOB_QUERY_EVENT = "tripp:bg-bash-jobs-query/v1";
export interface BackgroundJobState {
	id: string;
	status: "running" | "exited" | "killed";
	ownerSessionId?: string;
	cwd: string;
}
export interface BackgroundJobQuery {
	sessionId: string;
	available: boolean;
	jobs: BackgroundJobState[];
	error?: string;
}
export function isBackgroundJobQuery(value: unknown): value is BackgroundJobQuery {
	if (!value || typeof value !== "object") return false;
	const query = value as Partial<BackgroundJobQuery>;
	return typeof query.sessionId === "string" && typeof query.available === "boolean" && Array.isArray(query.jobs);
}
export function queryBackgroundJobs(pi: ExtensionAPI, sessionId: string): BackgroundJobQuery {
	const query: BackgroundJobQuery = { sessionId, available: false, jobs: [] };
	pi.events.emit(BG_JOB_QUERY_EVENT, query);
	return query;
}
