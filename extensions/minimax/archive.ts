import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stateRoot } from "../../lib/common.ts";

type Output = Extract<AgentMessage, { role: "toolResult" }>;
export type Artifact = { id: string; toolCallId: string; bytes: number };
// MiniMax's public defaults, in bytes (not tokens).
export const maxInlineBytes = 64 * 1024;
export const archiveThreshold = 256 * 1024;
const minCandidateBytes = 2 * 1024;
const receiptEstimateBytes = 512;
const controlTools = new Set([
  "skill", "ask_user", "request_feature_enable", "todowrite", "todo_write",
  "create_goal", "update_goal", "get_goal", "enterplanmode", "exitplanmode",
  "archive_read",
]);
const textBytes = (output: Output) => Buffer.byteLength(output.content
  .filter(block => block.type === "text").map(block => block.text).join("\n"));

// A round is settled only when every call has one adjacent result. Malformed
// histories are left alone, as in upstream's fail-closed planning path.
function candidateResults(messages: AgentMessage[]) {
  const rounds: { results: Output[]; settled: boolean }[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "toolResult") return [];
    if (message.role !== "assistant") continue;
    const calls = message.content.filter(block => block.type === "toolCall");
    if (!calls.length) continue;
    const pending = new Map(calls.map(call => [call.id, call]));
    if (pending.size !== calls.length) return [];
    const results: Output[] = [];
    for (let n = 0; n < calls.length; n++) {
      const output = messages[index + 1];
      if (!output) break;
      if (output.role !== "toolResult") return [];
      const call = pending.get(output.toolCallId);
      if (!call) return [];
      pending.delete(output.toolCallId);
      index++;
      if (!output.isError && !controlTools.has(call.name.trim().toLowerCase())) results.push(output);
    }
    rounds.push({ results, settled: pending.size === 0 });
  }
  return rounds.filter(round => round.settled).slice(0, -5).flatMap(round => round.results);
}
const marker = (artifact: Artifact) => `[minimax archive ${artifact.id}] ${artifact.bytes} bytes. Retrieve with archive_read({id:"${artifact.id}",offset:0,limit:16000}).`;
export function archiveReceipt(output: Output, artifact: Artifact): Output {
  return { ...output, content: [{ type: "text", text: `${output.isError ? "Tool failed. " : ""}${marker(artifact)}` }, ...output.content.filter(block => block.type !== "text")] };
}

// Preserve control-plane replies and bounded artifact retrieval. Never replace
// output until the durable artifact has been written and verified.
export async function capToolOutput(output: Output, archive: Archive) {
  if (controlTools.has(output.toolName.trim().toLowerCase()) || textBytes(output) <= maxInlineBytes) return;
  const artifact = await archive.save(output);
  await archive.read(artifact.id);
  return { artifact, output: archiveReceipt(output, artifact) };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export class Archive {
  constructor(readonly root = join(stateRoot(), "minimax", "artifacts")) {}

  async save(output: Output): Promise<Artifact> {
    const text = JSON.stringify(output);
    const id = digest(text);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(join(this.root, `${id}.json`), text, { mode: 0o600 });
    return { id, toolCallId: output.toolCallId, bytes: Buffer.byteLength(text) };
  }

  async read(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid archive ID");
    const text = await readFile(join(this.root, `${id}.json`), "utf8");
    if (digest(text) !== id) throw new Error("Archive integrity check failed");
    return text;
  }
}

// Only project model input. The session's original calls and results stay intact.
export async function archiveMessages(messages: AgentMessage[], known: Artifact[], archive: Archive, admit?: (before: AgentMessage[], after: AgentMessage[]) => boolean) {
  const saved = new Map(known.map(artifact => [artifact.toolCallId, artifact]));
  // Reapply receipts before measuring; archived originals must not inflate the watermark.
  const visible = messages.map(message => {
    const artifact = message.role === "toolResult" ? saved.get(message.toolCallId) : undefined;
    return artifact ? archiveReceipt(message as Output, artifact) : message;
  });
  const totalTextBytes = visible.reduce((total, message) => total + (message.role === "toolResult" ? textBytes(message) : 0), 0);
  const candidates = candidateResults(visible).filter(message => !saved.has(message.toolCallId) && textBytes(message) >= minCandidateBytes);
  const estimatedSavings = candidates.reduce((total, message) => total + Math.max(0, textBytes(message) - receiptEstimateBytes), 0);
  const added: Artifact[] = [];
  if (totalTextBytes > archiveThreshold && estimatedSavings > archiveThreshold) {
    for (const message of candidates) {
      const artifact = await archive.save(message);
      saved.set(message.toolCallId, artifact);
      added.push(artifact);
    }
  }
  const baseline: AgentMessage[] = [];
  const projected: AgentMessage[] = [];
  for (const message of messages) {
    const artifact = message.role === "toolResult" ? saved.get(message.toolCallId) : undefined;
    if (!artifact) { projected.push(message); baseline.push(message); continue; }
    // Never emit a reference to a missing or corrupt artifact.
    try { await archive.read(artifact.id); }
    catch { projected.push(message); baseline.push(message); continue; }
    const receipt = archiveReceipt(message as Output, artifact);
    projected.push(receipt);
    baseline.push(known.some(item => item.id === artifact.id) ? receipt : message);
  }
  if (added.length && admit && !admit(baseline, projected)) return { messages: baseline, added: [] };
  return { messages: projected, added };
}
