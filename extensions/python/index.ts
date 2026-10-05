import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse } from "smol-toml";
import { Type } from "typebox";
import { result, shellQuote } from "../../lib/common.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

export function scriptMetadata(code: string) {
  if (!code.trim()) throw new Error("code must not be blank.");
  const blocks = [...code.matchAll(/^# \/\/\/ script\r?\n((?:#(?: .*)?\r?\n)*)# \/\/\/\r?$/gm)];
  const starts = code.match(/^# \/\/\/ script\r?$/gm) ?? [];
  if (blocks.length !== 1 || starts.length !== 1) throw new Error("code must contain exactly one complete PEP 723 '# /// script' metadata block.");
  const toml = blocks[0][1].split(/\r?\n/).map(line => line.slice(2)).join("\n");
  let metadata;
  try { metadata = parse(toml); }
  catch (error) { throw new Error(`code has invalid PEP 723 TOML: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof metadata["requires-python"] !== "string" || !metadata["requires-python"].trim()) throw new Error("code metadata must define requires-python as a nonblank string, for example >=3.12.");
  if (!Array.isArray(metadata.dependencies) || metadata.dependencies.some(value => typeof value !== "string" || !value.trim())) throw new Error("code metadata must define dependencies as an array of package strings; use [] for standard-library-only scripts.");
  return metadata;
}

function quote(value: string) {
  if (value.includes("\0")) throw new Error("Script paths and args must not contain NUL characters.");
  return shellQuote(value);
}

export default function python(pi: ExtensionAPI) {
  pi.registerTool({
    name: "python", label: "Python", renderCall: toolCall("python"), renderResult,
    description: "Run inline Python source with uv run --script as a managed background task. code must include a PEP 723 '# /// script' block with requires-python (a version constraint) and dependencies (package strings, or [] for stdlib only). uv resolves dependencies and selects/downloads a compatible Python. Scripts are saved outside the project under Pi's agent directory. Runs in the current working directory without using the project environment. Returns a task ID immediately, not the script's output or proof of success. Do not rerun it; use task_output, task_query, task_stop, and task_watch. Requires the tasks extension and uv on PATH. Code has the same local permissions as Bash, not a sandbox.",
    parameters: Type.Object({
      code: Type.String({ minLength: 1, description: "Complete Python source, including PEP 723 requires-python and dependencies metadata. No Markdown fences." }),
      args: Type.Optional(Type.Array(Type.String({ description: "One literal script argument; no shell expansion." }))),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483.647, description: "Background deadline in seconds, including Python/dependency setup. Default 1800 (30 minutes). Expiry kills the process tree." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      scriptMetadata(params.code);
      const bash = ctx.tools.find(tool => tool.name === "bash");
      if (!bash?.parameters.properties?.run_in_background) throw new Error("python requires the tasks extension's managed Bash tool. Enable extensions/tasks and reload Pi.");
      const argumentsText = (params.args ?? []).map(quote).join(" ");
      const directory = join(getAgentDir(), "python", "scripts");
      const script = join(directory, `${randomUUID()}.py`);
      const command = `PYTHONUNBUFFERED=1 uv run --no-project --script ${quote(script)}${argumentsText ? ` ${argumentsText}` : ""}`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await withFileMutationQueue(script, () => writeFile(script, params.code, { encoding: "utf8", mode: 0o600, flag: "wx" }));
      let launched = false;
      try {
        signal?.throwIfAborted();
        const outcome = await ctx.executeTool("bash", { command, timeout: params.timeout, run_in_background: true }, { signal, onUpdate });
        if (outcome.isError) {
          // Pi accounts for nested usage itself; do not count it a second time.
          const { usage: _usage, ...failure } = outcome.result;
          return { ...failure, isError: true };
        }
        launched = true;
        const task = outcome.result.details;
        if (!task || typeof task.task_id !== "string") throw new Error("Managed Bash did not return a task ID. Inspect task_query before retrying.");
        return result({ ...task, script_path: script });
      } finally {
        if (!launched) await rm(script, { force: true });
      }
    },
  });
}
