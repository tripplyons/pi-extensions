/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted from SoL-Pi ObservationPack: https://github.com/NVlabs/SoL-Pi
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sessionStorage } from "../../lib/session-storage.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { EVIDENCE_RECEIPT } from "../evidence-preserving-reducer/receipt.ts";

export const THRESHOLD_BYTES = 10 * 1024;
// Provider requests that carry a large result before the placeholder replaces it.
export const FULL_SENDS = 2;
const EXCERPT_BYTES = 512;
const RECALL_BYTES = 16 * 1024 - 512;
const RECALL_LINES = 398;

type Observation = { id: string; path: string; tool: string; text: string; bytes: number; lines: number };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const countLines = (text: string) => text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
const objectsDir = (ctx: ExtensionContext) => join(sessionStorage(ctx, "observation-pack"), "objects");

function observe(message: any, dir: string): Observation | undefined {
  if (message.role !== "toolResult" || message.isError || !message.content.length) return;
  if (!message.content.every((block: any) => block.type === "text")) return;
  const text = message.content.map((block: any) => block.text).join("\n");
  const bytes = Buffer.byteLength(text);
  // Evidence receipts already reduce a long log; an excerpt would drop verified quotes.
  if (bytes <= THRESHOLD_BYTES || text.split("\n").includes(EVIDENCE_RECEIPT)) return;
  const id = `obs_${sha256(`${message.toolName}\0${message.toolCallId}\0${sha256(text)}`).slice(0, 24)}`;
  return { id, path: join(dir, `${id}.txt`), tool: message.toolName, text, bytes, lines: countLines(text) };
}

// Objects are content addressed: reuse one only if its bytes still match.
async function store(observation: Observation) {
  await mkdir(join(observation.path, ".."), { recursive: true, mode: 0o700 });
  try {
    const file = await open(observation.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(observation.text); } finally { await file.close(); }
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const file = await open(observation.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (sha256(await file.readFile()) !== sha256(observation.text)) throw new Error(`Stored observation ${observation.id} changed`);
    } finally { await file.close(); }
  }
}

function excerpt(text: string, fromEnd: boolean) {
  const lines = text.split(/(?<=\n)/);
  if (fromEnd) lines.reverse();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line);
    if (bytes > EXCERPT_BYTES) break;
    kept.push(line);
  }
  return (fromEnd ? kept.reverse() : kept).join("");
}

export function placeholder(observation: Observation) {
  return [
    `[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
    `id: ${observation.id}`,
    `tool: ${observation.tool}`,
    `original_bytes: ${observation.bytes}`,
    `original_lines: ${observation.lines}`,
    `estimated_tokens: ${Math.ceil(observation.text.length / 4)}`,
    `retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; continue with returned next_offset`,
    `[first complete lines, up to ${EXCERPT_BYTES} bytes]`,
    excerpt(observation.text, false),
    `[middle omitted; last complete lines, up to ${EXCERPT_BYTES} bytes]`,
    excerpt(observation.text, true),
    `[${observation.bytes} original bytes omitted]`,
  ].join("\n");
}

// Read whole lines up to the page limits without splitting a UTF-8 character.
async function readPage(path: string, offset: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    if (offset > size) throw new Error(`Offset ${offset} exceeds observation size ${size}`);
    const buffer = Buffer.alloc(Math.min(size - offset, RECALL_BYTES));
    await file.read(buffer, 0, buffer.length, offset);
    let end = buffer.length;
    for (let index = 0, lines = 0; index < buffer.length; index++) {
      if (buffer[index] === 0x0a && ++lines === RECALL_LINES) { end = index + 1; break; }
    }
    while (end > 0 && end < size - offset && (buffer[end]! & 0xc0) === 0x80) end--;
    const text = buffer.subarray(0, end).toString("utf8");
    return { text, bytes: end, lines: countLines(text), nextOffset: offset + end, eof: offset + end >= size };
  } finally { await file.close(); }
}

export default function observationPack(pi: ExtensionAPI) {
  const stored = new Set<string>();
  pi.registerTool({
    name: "obs_recall",
    label: "Recall observation",
    description: "Read a stored large tool result by observation id and byte offset.",
    promptSnippet: "Recall a paged excerpt from a previously replaced large tool result",
    parameters: Type.Object({
      id: Type.String({ pattern: "^obs_[a-f0-9]{24}$", description: "Observation id from a placeholder" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, default 0" })),
    }),
    async execute(_id, { id, offset = 0 }, _signal, _onUpdate, ctx) {
      if (!/^obs_[a-f0-9]{24}$/.test(id)) throw new Error(`Unknown observation id: ${id}`);
      const page = await readPage(join(objectsDir(ctx), `${id}.txt`), offset).catch(error => {
        throw error?.code === "ENOENT" ? new Error(`Unknown observation id: ${id}`) : error;
      });
      const header = `[obs_recall id=${id} offset=${offset} next_offset=${page.nextOffset} eof=${page.eof}]\n[chunk_bytes=${page.bytes} chunk_lines=${page.lines}; use next_offset to continue]`;
      return { content: [{ type: "text", text: `${header}\n${page.text}` }], details: undefined };
    },
    renderCall: toolCall("obs_recall"),
    renderResult,
  });

  // Rewrite only the provider projection, so the saved session keeps every result.
  pi.on("context", async (event, ctx) => {
    let dir: string;
    try { dir = objectsDir(ctx); } catch { return; }
    // Each later assistant message is one provider request that carried the result.
    let sends = 0;
    const messages = [...event.messages];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === "assistant") { sends++; continue; }
      if (sends < FULL_SENDS) continue;
      const observation = observe(message, dir);
      if (!observation) continue;
      try {
        if (!stored.has(observation.path)) await store(observation);
        stored.add(observation.path);
        messages[index] = { ...message, content: [{ type: "text", text: placeholder(observation) }] } as typeof message;
      } catch {
        // Keep the full result if it cannot be stored for recall.
      }
    }
    return { messages };
  });
}
