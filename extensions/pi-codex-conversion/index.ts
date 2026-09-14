import codexConversion from "@howaboua/pi-codex-conversion";
import { closeOpenAICodexWebSocketSessions } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMixtureSessionRelease, MIXTURE_SESSION_RELEASE_EVENT } from "../mixture/events.ts";

export function closeMixtureCodexSessions(value: unknown, close = closeOpenAICodexWebSocketSessions) {
	if (!isMixtureSessionRelease(value)) return;
	for (const id of value.sessionIds) close(id);
}

export function preserveNativeFollowUpShortcut(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "registerShortcut") return Reflect.get(target, property, receiver);
			return (
				key: Parameters<ExtensionAPI["registerShortcut"]>[0],
				options: Parameters<ExtensionAPI["registerShortcut"]>[1],
			) => {
				if (key.toLowerCase() === "alt+enter") return;
				return target.registerShortcut(key, options);
			};
		},
	});
}

export default function piCodexConversion(pi: ExtensionAPI) {
	pi.events.on(MIXTURE_SESSION_RELEASE_EVENT, closeMixtureCodexSessions);
	return codexConversion(preserveNativeFollowUpShortcut(pi));
}
