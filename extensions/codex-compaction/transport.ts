import { checkpoint, compactRequest, type Item } from "./protocol.ts";

// Never include response bodies or credential material in errors.
export async function readCheckpoint(response: Response, signal?: AbortSignal): Promise<Item> {
  if (!response.ok) throw new Error(`Codex compaction failed (HTTP ${response.status})`);
  if (!response.body) throw new Error("Empty Codex compaction response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let total = 0;
  let found: Item | undefined;
  const outputs = new Map<number, Item>();
  function event(text: string) {
    const data = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed: Item;
    try { parsed = JSON.parse(data); } catch { throw new Error("Invalid Codex compaction stream JSON"); }
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid Codex compaction event");
    if (["error", "response.failed", "response.incomplete"].includes(String(parsed.type))) throw new Error("Codex compaction stream failed");
    if (parsed.type === "response.output_item.done") {
      if (!Number.isSafeInteger(parsed.output_index) || Number(parsed.output_index) < 0 ||
          !parsed.item || typeof parsed.item !== "object" || Array.isArray(parsed.item)) {
        throw new Error("Invalid Codex compaction output item");
      }
      const index = Number(parsed.output_index);
      if (outputs.has(index)) throw new Error("Duplicate Codex compaction output item");
      outputs.set(index, parsed.item as Item);
    }
    if (parsed.type === "response.completed") {
      if (found) throw new Error("Duplicate Codex compaction completion");
      if (!parsed.response || typeof parsed.response !== "object") throw new Error("Missing Codex compaction response");
      const response = parsed.response as Item;
      const output = response.output;
      // Responses may deliver output only through output_item.done events.
      // Prefer an explicit nonempty terminal output, as Stack's assembler does.
      const assembled = [...outputs.entries()].sort(([a], [b]) => a - b);
      if (assembled.some(([index], position) => index !== position)) throw new Error("Incomplete Codex compaction output sequence");
      found = checkpoint({ ...response, status: response.status ?? "completed",
        output: output === undefined || (Array.isArray(output) && output.length === 0)
          ? assembled.map(([, item]) => item) : output });
    }
  }
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > 16 * 1024 * 1024) throw new Error("Codex compaction stream exceeds 16 MiB");
      buffer += decoder.decode(value, { stream: true });
      // Normalize only complete lines, retaining a possible split CRLF.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, match.index).replaceAll("\r\n", "\n"));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer.replaceAll("\r\n", "\n"));
    if (!found) throw new Error("Codex compaction stream ended without a checkpoint");
    return found;
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function compactRemote(
  body: Item, sessionId: string, token: string, signal: AbortSignal,
  options: { request?: typeof fetch; endpoint?: string; headers?: Record<string, string> } = {},
) {
  let account: unknown;
  try { account = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())["https://api.openai.com/auth"]?.chatgpt_account_id; } catch { /* sanitized boundary error below */ }
  if (!token || /[\r\n]/.test(token) || typeof account !== "string" || !account || /[\r\n]/.test(account)) throw new Error("Codex OAuth credentials unavailable; use /login");
  const prepared = compactRequest(body, sessionId, options.headers ?? {});
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  bounded.throwIfAborted();
  const response = await (options.request ?? fetch)(options.endpoint ?? "https://chatgpt.com/backend-api/codex/responses", {
    method: "POST", redirect: "error", signal: bounded,
    headers: { ...prepared.headers, Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account,
      "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(prepared.body),
  });
  return [...prepared.retained, await readCheckpoint(response, bounded)];
}
