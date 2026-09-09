import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SWARM_ATTACHMENT_QUERY_EVENT = "tripp:agent-swarm-attachment-query/v1";
export const SWARM_ATTACHMENT_CHANGED_EVENT = "tripp:agent-swarm-attachment-changed/v1";

interface AttachmentQuery {
	attached: boolean;
}

export const isSwarmAttached = (pi: ExtensionAPI) => {
	const query: AttachmentQuery = { attached: false };
	pi.events.emit(SWARM_ATTACHMENT_QUERY_EVENT, query);
	return query.attached;
};

export function publishSwarmAttachment(pi: ExtensionAPI, initiallyAttached = false) {
	let attached = initiallyAttached;
	const unsubscribe = pi.events.on(SWARM_ATTACHMENT_QUERY_EVENT, (query: AttachmentQuery) => {
		if (attached) query.attached = true;
	});
	const notify = () => pi.events.emit(SWARM_ATTACHMENT_CHANGED_EVENT, { attached });
	notify();
	return {
		set(value: boolean) {
			if (value === attached) return;
			attached = value;
			notify();
		},
		dispose() {
			attached = false;
			unsubscribe();
			notify();
		},
	};
}
