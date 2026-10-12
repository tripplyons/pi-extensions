/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted from SoL-Pi Action Fusion: https://github.com/NVlabs/SoL-Pi
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// The evidence-preserving reducer reads these markers in fused results.
export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

type ThenRun = { command: string; timeout?: number };
type BaseTool = ToolDefinition<any, any>;

const queueTails = new Map<string, Promise<void>>();

function thenRunSchema(action: "edit" | "write") {
  return Type.Optional(Type.Object({
    command: Type.String({ description: "Bash command to run" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  }, {
    description: `Command to run next on this file after the ${action} succeeds, such as run, build, start, restart, install, or check; optional timeout in seconds. Skipped if the ${action} fails. A non-zero exit is reported but keeps the ${action}.`,
  }));
}

// Match Pi's resolveToCwd so the queue and change guard address the file the built-in tool wrote.
export function resolveToolPath(cwd: string, path: string): string {
  let value = path.replace(/[  -   　]/gu, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return resolve(cwd, value);
}

// Resolve symlinks in the longest existing prefix so new files and their aliases share a key.
async function queueKey(path: string): Promise<string> {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      if (dirname(current) === current) return path;
      missing.unshift(basename(current));
    }
  }
}

// Pi's mutation queue is held by the built-in tool, so fused work needs its own queue per file.
async function withFileQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = await queueKey(path);
  const previous = queueTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>(done => { release = done; }));
  queueTails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queueTails.get(key) === tail) queueTails.delete(key);
  }
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const outputText = (result: AgentToolResult<unknown>) =>
  result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");

// Skip the command if another process changes the file right after the mutation.
export async function assertUnchanged(path: string, yieldToOthers = () => new Promise<void>(done => setImmediate(done))) {
  try {
    const written = await sha256(path);
    await yieldToOthers();
    if (await sha256(path) !== written) throw new Error("target content changed after the fused mutation");
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${message(error)}; the command was not run.`);
  }
}

async function mutateThenRun<T>(
  path: string,
  thenRun: ThenRun | undefined,
  mutate: () => Promise<AgentToolResult<T>>,
  run: (thenRun: ThenRun) => Promise<AgentToolResult<unknown>>,
): Promise<AgentToolResult<T>> {
  return withFileQueue(path, async () => {
    let result: AgentToolResult<T>;
    try {
      result = await mutate();
    } catch (error) {
      if (!thenRun) throw error;
      throw new Error(`${message(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`);
    }
    if (!thenRun) return result;
    await assertUnchanged(path);
    // Pi's Bash returns non-zero exits as error results and throws on timeouts and aborts.
    let ran: AgentToolResult<unknown>;
    try {
      ran = await run(thenRun);
    } catch (error) {
      ran = { content: [{ type: "text", text: message(error) }], details: undefined, isError: true };
    }
    const marker = ran.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
    const output = outputText(ran);
    return {
      ...result,
      content: [...result.content, { type: "text", text: output ? `${marker}\n${output}` : marker }],
      ...(ran.isError ? { isError: true } : {}),
    };
  });
}

// Built-in definitions capture cwd, so keep one per directory for execution and rendering.
function perCwd(create: (cwd: string) => BaseTool) {
  const cache = new Map<string, BaseTool>();
  return (cwd: string) => {
    let tool = cache.get(cwd);
    if (!tool) cache.set(cwd, tool = create(cwd));
    return tool;
  };
}

function registerFused(pi: ExtensionAPI, action: "edit" | "write", base: (cwd: string) => BaseTool) {
  const bash = perCwd(cwd => createBashToolDefinition(cwd));
  const template = base(process.cwd());
  pi.registerTool<any, any>({
    ...template,
    parameters: Type.Object({ ...template.parameters.properties, then_run: thenRunSchema(action) }),
    execute(toolCallId, input, signal, onUpdate, ctx) {
      const { then_run, ...args } = input as Record<string, unknown> & { path: string; then_run?: ThenRun };
      return mutateThenRun(
        resolveToolPath(ctx.cwd, args.path),
        then_run,
        () => base(ctx.cwd).execute(toolCallId, args, signal, onUpdate, ctx),
        command => bash(ctx.cwd).execute(`${toolCallId}:then_run`, command, signal, undefined, ctx),
      );
    },
    renderCall: (args, theme, context) => base(context.cwd).renderCall!(args, theme, context),
    renderResult: (result, options, theme, context) => base(context.cwd).renderResult!(result, options, theme, context),
  });
}

export default function actionFusion(pi: ExtensionAPI) {
  registerFused(pi, "edit", perCwd(cwd => createEditToolDefinition(cwd)));
  registerFused(pi, "write", perCwd(cwd => createWriteToolDefinition(cwd)));
}
