import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function result<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}

export function text(value: string, name: string, max = Infinity) {
  if (!value.trim() || [...value].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw new Error(`${name} must contain text, at most ${max} characters, without control characters`);
  }
  return value;
}

export function stateRoot(env = process.env) {
  const root = env.PI_REWORK_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-rework");
  if (!isAbsolute(root)) throw new Error("PI_REWORK_STATE_DIR and XDG_STATE_HOME must be absolute");
  return root;
}

// Read the active branch, not all entries: forks must not inherit abandoned state.
export function restore<T>(ctx: ExtensionContext, key: string): T | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type === "custom" && entry.customType === key) return structuredClone(entry.data) as T;
  }
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
