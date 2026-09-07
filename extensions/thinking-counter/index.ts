import {
	AssistantMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { installThinkingCounter, type ThinkingComponentPrototype } from "./logic.ts";

export default function thinkingCounterExtension(pi: ExtensionAPI) {
	const prototype = AssistantMessageComponent.prototype as unknown as ThinkingComponentPrototype;
	const restore = installThinkingCounter(prototype);
	pi.on("session_shutdown", restore);
}
