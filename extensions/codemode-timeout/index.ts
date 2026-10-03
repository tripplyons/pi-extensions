import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_TIMEOUT_MS = 300_000;
const OPTIONS_PREFIX = "// @options:";

export function capCodemodeTimeout(source: string): string {
  if (!source.trim()) return source;

  const newline = source.indexOf("\n");
  const firstLine = (newline === -1 ? source : source.slice(0, newline)).trimStart();
  if (!firstLine.startsWith(OPTIONS_PREFIX)) {
    return `${OPTIONS_PREFIX} {"timeout_ms":${MAX_TIMEOUT_MS}}\n${source}`;
  }

  // Leave invalid directives to Pi's native input validation.
  let options: Record<string, unknown>;
  try {
    options = JSON.parse(firstLine.slice(OPTIONS_PREFIX.length));
  } catch {
    return source;
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) return source;
  const timeout = options.timeout_ms;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0)) {
    return source;
  }
  if (typeof timeout === "number" && timeout <= MAX_TIMEOUT_MS) return source;

  return `${OPTIONS_PREFIX} ${JSON.stringify({ ...options, timeout_ms: MAX_TIMEOUT_MS })}${newline === -1 ? "" : source.slice(newline)}`;
}

export default function codemodeTimeout(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "codemode" || typeof event.input.code !== "string") return;
    event.input.code = capCodemodeTimeout(event.input.code);
  });
}
