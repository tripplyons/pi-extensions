// Codex remote compaction v2 operates on the provider's Responses wire input.
export type Item = Record<string, unknown>;

export function pairedInput(input: Item[]): Item[] {
  const calls = new Set<unknown>();
  const outputs = new Set<unknown>();
  for (const item of input) {
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || calls.has(item.call_id)) throw new Error("Invalid or duplicate function call before compaction");
      calls.add(item.call_id);
    } else if (item.type === "function_call_output") {
      if (!calls.has(item.call_id) || outputs.has(item.call_id)) throw new Error("Orphaned function output before compaction");
      outputs.add(item.call_id);
    }
  }
  return input.filter(item => item.type !== "function_call" || outputs.has(item.call_id));
}

export function retainedUsers(input: Item[], budget = 256_000): Item[] {
  const retained: Item[] = [];
  for (let index = input.length - 1; index >= 0 && budget > 0; index--) {
    const item = input[index];
    if (item.role !== "user") continue;
    const content = typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content;
    if (!Array.isArray(content)) continue;
    const parts: Item[] = [];
    for (const part of content) {
      if (part.type !== "input_text" || typeof part.text !== "string") continue;
      const bytes = Buffer.from(part.text);
      let end = Math.min(bytes.length, budget);
      while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      if (end) parts.push({ type: "input_text", text: bytes.subarray(0, end).toString("utf8") });
      budget -= end;
    }
    if (parts.length) retained.unshift({ type: "message", role: "user", content: parts });
  }
  return retained;
}

export function compactRequest(body: Item, sessionId: string, headers: Record<string, string>) {
  if (!Array.isArray(body.input)) throw new Error("Codex request input must be an array");
  const input = pairedInput(body.input);
  const request: Item = { ...body, input: [...input, { type: "compaction_trigger" }], store: false,
    stream: true, tool_choice: "auto", parallel_tool_calls: true, prompt_cache_key: sessionId };
  delete request.previous_response_id;
  delete request.messages;
  if (body.model === "gpt-6-astra") {
    request.reasoning = { effort: "low", summary: "auto" };
    request.service_tier = "priority";
  }
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const features = new Set((normalized["x-codex-beta-features"] ?? "").split(",").map(value => value.trim()).filter(Boolean));
  features.add("remote_compaction_v2");
  normalized["x-codex-beta-features"] = [...features].sort().join(",");
  normalized.version = "0.153.0";
  normalized["x-codex-routing-hint"] = `model=${body.model}${request.service_tier ? `;tier=${request.service_tier}` : ""}`;
  return { body: request, headers: normalized, retained: retainedUsers(input) };
}

export function checkpoint(response: Item): Item {
  const output = response.output;
  if (response.status !== "completed" || !Array.isArray(output) || output.length !== 1 ||
      output[0]?.type !== "compaction" || typeof output[0].encrypted_content !== "string" || !output[0].encrypted_content) {
    throw new Error("Codex did not return exactly one completed opaque compaction item");
  }
  return output[0];
}
