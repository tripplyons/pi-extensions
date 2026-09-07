export const CODEX_COMPACTION_STARTED_EVENT = "tripp:codex-compaction:v1:started";
export const CODEX_COMPACTION_COMMITTED_EVENT = "tripp:codex-compaction:v1:committed";
export const CODEX_COMPACTION_FAILED_EVENT = "tripp:codex-compaction:v1:failed";
export const CODEX_COMPACTION_CAPABILITY_EVENT = "tripp:codex-compaction:v1:capability";
export const CODEX_NATIVE_COMPACTION_KIND = "openai-codex-native-compaction";

export type CodexCompactionReason = "manual" | "threshold" | "overflow";

export type CodexCompactionCapabilityQuery = {
	provider?: string;
	api?: string;
	available: boolean;
};

export type CodexCompactionStarted = {
	transactionId: string;
	sessionId: string;
	reason: CodexCompactionReason;
	checkpointId: string;
	sourceLeafId: string;
};

export type CodexCompactionCommitted = CodexCompactionStarted & {
	compactionEntryId: string;
};

export type CodexCompactionFailed = CodexCompactionStarted & {
	error?: string;
};
