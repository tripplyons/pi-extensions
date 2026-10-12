/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted from SoL-Pi Evidence-Preserving Reducer: https://github.com/NVlabs/SoL-Pi
 */
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { completeLuna } from "../../lib/luna.ts";
import { sessionStorage } from "../../lib/session-storage.ts";
import { THEN_RUN_FAILED, THEN_RUN_SUCCEEDED } from "../action-fusion/index.ts";
import { instructions, receiptText, reducerInput, RECEIPT_SCHEMA, sha256, validate, type Source } from "./receipt.ts";

export const JOURNAL_TYPE = "evidence-preserving-reducer";
export const DIAGNOSTIC_COMMAND = /(?:^|[;&|()\s])(?:lake\s+build|lake\s+env\s+lean|lean|coq|cargo(?:\s+(?:build|test|check))?|zig\s+build|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)|ctest|cmake\s+--build|ninja|make|npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|go\s+test|bazel\s+test)(?:\s|$)/i;
const LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i;
export const MIN_BYTES = 4096;
const MAX_CHARS = 600_000;
const MAX_OUTPUT_TOKENS = 2048;
const TIMEOUT_MS = 90_000;

type Candidate = { command: string; body: string; project: (receipt: string) => ToolResultEvent["content"] };

const textOf = (content: ToolResultEvent["content"]) =>
  content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");

// Bash keeps untruncated output in a private temp file; quote checks need those exact bytes.
async function fullOutput(inline: string, details: unknown) {
  const fromDetails = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
  const path = typeof fromDetails === "string" ? fromDetails : inline.match(/Full output:\s*([^\]\r\n]+)/u)?.[1]?.trim();
  if (!path || !/^pi-bash-[^/\\]+\.log$/u.test(basename(path))) return inline;
  try {
    const [real, root, stat] = await Promise.all([realpath(path), realpath(tmpdir()), lstat(path)]);
    if (!stat.isFile() || dirname(real) !== root) return inline;
    return await readFile(path, "utf8");
  } catch {
    return inline;
  }
}

// Find the command output in a Bash result or after the then_run marker of a fused edit or write.
async function candidate(event: ToolResultEvent): Promise<Candidate | undefined> {
  if (event.toolName === "bash") {
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !command) return;
    return { command, body: await fullOutput(textOf(event.content), event.details), project: text => [{ type: "text", text }] };
  }
  if (event.toolName !== "edit" && event.toolName !== "write") return;
  const command = (event.input as { then_run?: { command?: unknown } }).then_run?.command;
  if (typeof command !== "string" || !command) return;
  const marker = `${event.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED}\n`;
  const index = event.content.findIndex(block => block.type === "text" && block.text.startsWith(marker));
  if (index < 0) return;
  const inline = (event.content[index] as { text: string }).text.slice(marker.length);
  return {
    command,
    body: await fullOutput(inline, undefined),
    project: text => event.content.map((block, at) => at === index ? { type: "text", text: `${marker}${text}` } : block),
  };
}

// Content-addressed: an existing object with other bytes is an integrity failure.
async function archive(root: string, body: string) {
  const hash = sha256(body);
  const dir = join(root, "objects", hash.slice(0, 2));
  const path = join(dir, `${hash}.txt`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, body, { flag: "wx", mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== body) throw new Error(`Reducer archive integrity failure: ${path}`);
  }
  return { hash, path };
}

async function reduce(source: Source, ctx: ExtensionContext) {
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  return completeLuna(ctx, {
    systemPrompt: instructions,
    messages: [{ role: "user", content: [{ type: "text", text: reducerInput(source) }], timestamp: Date.now() }],
  }, { maxTokens: MAX_OUTPUT_TOKENS, signal });
}

export default function evidencePreservingReducer(pi: ExtensionAPI) {
  // Journal entries stay out of model context and record why each log was or was not reduced.
  const journal = (kind: string, data: object = {}) => pi.appendEntry(JOURNAL_TYPE, { kind, ...data });

  pi.on("tool_result", async (event, ctx) => {
    const found = await candidate(event);
    if (!found || !DIAGNOSTIC_COMMAND.test(found.command) || Buffer.byteLength(found.body) < MIN_BYTES) return;
    const fallback = (reason: string, data: object = {}) => { journal("fallback", { toolCallId: event.toolCallId, reason, ...data }); };
    if (found.body.length > MAX_CHARS) return fallback("source-over-max-chars", { sourceChars: found.body.length });
    if (LIKELY_SECRET.test(found.body)) return fallback("likely-secret");

    let source: Source;
    try {
      const stored = await archive(sessionStorage(ctx, "evidence-preserving-reducer"), found.body);
      source = { command: found.command, body: found.body, isError: event.isError, ...stored };
    } catch (error) {
      return fallback("archive-failed", { error: error instanceof Error ? error.message : String(error) });
    }

    let response: AssistantMessage;
    try {
      response = await reduce(source, ctx);
    } catch (error) {
      return fallback("model-call-failed", { sourceSha256: source.hash, error: error instanceof Error ? error.message : String(error) });
    }
    if (response.stopReason !== "stop" && response.stopReason !== "length") {
      return fallback("model-response-error", { sourceSha256: source.hash, stopReason: response.stopReason, error: response.errorMessage });
    }
    const checked = validate(textOf(response.content), source);
    if (typeof checked === "string") return fallback(checked, { sourceSha256: source.hash, usage: response.usage });

    const receipt = receiptText(source, checked, `${response.provider}/${response.model}`);
    const receiptBytes = Buffer.byteLength(receipt);
    const sourceBytes = Buffer.byteLength(source.body);
    if (receiptBytes >= sourceBytes) return fallback("receipt-not-smaller", { sourceSha256: source.hash, receiptBytes, sourceBytes });

    const record = {
      schema: RECEIPT_SCHEMA,
      sourceSha256: source.hash,
      sourceBytes,
      receiptBytes,
      evidenceCount: checked.evidence.length,
      uncertain: checked.uncertain,
    };
    journal("applied", { toolCallId: event.toolCallId, ...record, usage: response.usage });
    return {
      content: found.project(receipt),
      details: { ...(event.details && typeof event.details === "object" ? event.details : {}), evidencePreservingReducer: record },
    };
  });
}
