import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MIXTURE_SESSION_RELEASE_EVENT = "tripp:mixture-session-release/v1";

export interface MixtureSessionRelease {
	sessionIds: string[];
}

export function isMixtureSessionRelease(value: unknown): value is MixtureSessionRelease {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& Array.isArray((value as Partial<MixtureSessionRelease>).sessionIds)
		&& (value as Partial<MixtureSessionRelease>).sessionIds!.every(id => typeof id === "string" && id.length > 0);
}

export function releaseProviderSessions(pi: ExtensionAPI, sessionIds: string[]) {
	const unique = [...new Set(sessionIds)];
	for (const id of unique) cleanupSessionResources(id);
	pi.events.emit(MIXTURE_SESSION_RELEASE_EVENT, { sessionIds: unique } satisfies MixtureSessionRelease);
}
