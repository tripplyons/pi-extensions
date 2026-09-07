import {
	InteractiveMode,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { installMessageWindow, type InteractiveModePrototype } from "./logic.ts";

const MAX_UI_MESSAGES = 50;

export default function messageWindowExtension(pi: ExtensionAPI) {
	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	const restore = installMessageWindow(prototype, MAX_UI_MESSAGES);
	pi.on("session_shutdown", restore);
}
