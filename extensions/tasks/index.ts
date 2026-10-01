import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskTools } from "./tasks.ts";

export default function tasks(pi: ExtensionAPI) {
  registerTaskTools(pi);
}
