import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolCall, renderResult } from "../../lib/tool-preview.ts";

const searchResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context) =>
  renderResult({ ...result, details: undefined }, options, theme, context);

const pageFields = {
  path: Type.Optional(Type.String({ minLength: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Zero-based result offset. Use next_offset for the next page." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  includeIgnored: Type.Optional(Type.Boolean({ description: "Include hidden and ignored files. Requires an explicit path." })),
};
const grepSchema = Type.Object({
  ...pageFields, pattern: Type.String(), glob: Type.Optional(Type.String()),
  mode: Type.Optional(StringEnum(["content", "files", "count"] as const)),
  ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
});
const globSchema = Type.Object({
  ...pageFields, pattern: Type.String(),
  sort: Type.Optional(StringEnum(["path", "modified"] as const)),
});

// Stream until a page plus one lookahead record is available. Never buffer a
// repository-sized result; even a single oversized JSON line has a hard cap.
function searchPage(args: string[], cwd: string, offset: number, limit: number, json: boolean, mode: string, signal?: AbortSignal) {
  return new Promise<{ content: { type: "text"; text: string }[]; details: { next_offset: number | null } }>((resolvePage, reject) => {
    signal?.throwIfAborted();
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    const rows: string[] = [];
    let pending = "", stderr = "", seen = 0, bytes = 0, more = false;
    let failure: Error | undefined;
    const stop = () => child.kill();
    const abort = () => { failure = new Error("Search aborted"); stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { failure = new Error("Search timed out; narrow the path or pattern"); stop(); }, 30_000);
    function row(text: string) {
      if (more || seen++ < offset) return;
      if (Buffer.byteLength(text) > 48 * 1024) throw new Error("Search result exceeds 48 KiB; narrow the path or use read");
      if (rows.length >= limit || bytes + Buffer.byteLength(text) + 1 > 48 * 1024) { more = true; stop(); return; }
      rows.push(text); bytes += Buffer.byteLength(text) + 1;
    }
    function record(text: string) {
      if (!json) { row(JSON.stringify(text)); return; }
      const entry = JSON.parse(text);
      const data = entry.data;
      if (mode === "count") {
        if (entry.type === "end" && data.stats.matched_lines > 0) row(`${JSON.stringify(data.path.text ?? Buffer.from(data.path.bytes, "base64").toString())}:${data.stats.matched_lines}`);
      } else if (entry.type === "match" || entry.type === "context") {
        const path = data.path.text ?? Buffer.from(data.path.bytes, "base64").toString();
        const line = (data.lines.text ?? Buffer.from(data.lines.bytes, "base64").toString()).replace(/\r?\n$/, "");
        row(`${JSON.stringify(path)}:${data.line_number}:${line.length > 500 ? Array.from(line).slice(0, 500).join("") + " [line truncated; use read]" : line}`);
      }
    }
    child.stdout.on("data", chunk => {
      if (failure || more) return;
      pending += decoder.write(chunk);
      const separator = json ? "\n" : "\0";
      let end: number;
      try {
        while (!more && (end = pending.indexOf(separator)) >= 0) {
          if (end > 1024 * 1024) throw new Error("Search record exceeds 1 MiB; narrow the search or use read");
          const text = pending.slice(0, end); pending = pending.slice(end + 1);
          if (text) record(text);
        }
        if (!more && pending.length > 1024 * 1024) throw new Error("Search record exceeds 1 MiB; narrow the search or use read");
      } catch (error) { failure = error as Error; stop(); }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (!more && code !== 0 && code !== 1) { reject(new Error(stderr || `rg exited with ${code}`)); return; }
      const next = more ? offset + rows.length : null;
      resolvePage({ content: [{ type: "text", text: `${rows.join("\n") || "No results."}\n\nnext_offset: ${next ?? "null"}` }], details: { next_offset: next } });
    });
  });
}

export function registerSearchTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep", label: "grep", parameters: grepSchema, renderCall: toolCall("grep"), renderResult: searchResult,
    description: "Search with ripgrep. Modes: content (default), files (filenames only), count (matching lines per file). Stable path order; zero-based offset pages, next_offset in result. Default 100 records, max 1000 and 48 KiB. Content/context lines are separate records, clipped to 500 characters. Respects ignore files by default. Requires rg on PATH.",
    async execute(_id, input, signal, _update, ctx) {
      if (input.includeIgnored && !input.path) throw new Error("includeIgnored requires an explicit scoped path");
      const mode = input.mode ?? "content";
      const args = ["--no-config", "--color", "never", "--sort", "path", ...(mode === "files" ? ["--files-with-matches", "--null"] : ["--json"])];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.glob) args.push("--glob", input.glob);
      if (input.includeIgnored) args.push("--hidden", "--no-ignore");
      if (mode === "content" && input.context) args.push("--context", String(input.context));
      args.push("--regexp", input.pattern, "--", resolve(ctx.cwd, input.path ?? "."));
      return searchPage(args, ctx.cwd, input.offset ?? 0, input.limit ?? 100, mode !== "files", mode, signal);
    },
  });
  pi.registerTool({
    name: "glob", label: "glob", parameters: globSchema, renderCall: toolCall("glob"), renderResult: searchResult,
    description: "Find files with ripgrep globs. Zero-based offset pages with next_offset; default 1000 records, max 1000 and 48 KiB. Sort by path (default) or modified (newest first). Respects ignore files by default. Pages rerun the search; keep the same arguments and avoid file changes between pages. Requires rg on PATH.",
    async execute(_id, input, signal, _update, ctx) {
      if (input.includeIgnored && !input.path) throw new Error("includeIgnored requires an explicit scoped path");
      const args = ["--no-config", "--files", "--null", input.sort === "modified" ? "--sortr" : "--sort", input.sort === "modified" ? "modified" : "path", "--glob", input.pattern];
      if (input.includeIgnored) args.push("--hidden", "--no-ignore");
      args.push("--", resolve(ctx.cwd, input.path ?? "."));
      return searchPage(args, ctx.cwd, input.offset ?? 0, input.limit ?? 1000, false, "files", signal);
    },
  });
}
