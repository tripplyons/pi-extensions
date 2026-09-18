import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { result } from "../../lib/common.ts";

function decode(bytes: Uint8Array) {
  if (bytes.includes(0)) throw new Error("Binary files are not supported");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Invalid UTF-8 or byte range splits a character"); }
}
const pathSchema = Type.String({ minLength: 1 });
const limitSchema = Type.Integer({ minimum: 1 });
export default function files(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== "edit" && name !== "write"));
  });
  pi.registerTool({ name: "read", label: "Read", description: "Read a bounded UTF-8 byte range. Offset and limit must not split a character. Binary files are rejected. Absolute and outside-workspace paths supported.",
    parameters: Type.Object({ path: pathSchema, offset: Type.Integer({ minimum: 0 }), limit: limitSchema }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const file = await open(resolve(ctx.cwd, args.path), "r");
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Not a regular file");
        const length = Math.min(args.limit, Math.max(0, info.size - args.offset));
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, args.offset);
        return result({ content: decode(buffer.subarray(0, bytesRead)), truncated: args.offset + bytesRead < info.size });
      } finally { await file.close(); }
    } });
  pi.registerTool({ name: "list", label: "List", description: "List directory entries, optionally recursively. Does not descend through symlink directories.",
    parameters: Type.Object({ path: pathSchema, recursive: Type.Boolean(), max_results: limitSchema }),
    async execute(_id, args, signal, _update, ctx) {
      const entries: { path: string; directory: boolean; symlink: boolean }[] = [];
      let truncated = false;
      async function visit(path: string) {
        for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          signal?.throwIfAborted();
          if (entries.length >= args.max_results) { truncated = true; return; }
          const child = join(path, entry.name);
          entries.push({ path: child, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
          if (args.recursive && entry.isDirectory()) await visit(child);
          if (truncated) return;
        }
      }
      await visit(resolve(ctx.cwd, args.path)); return result({ entries, truncated });
    } });
  pi.registerTool({ name: "search", label: "Search", description: "Search UTF-8 files for a literal string. Skips binary files, files over 1 MiB, and links outside the requested tree; reports skipped_files and truncated.",
    parameters: Type.Object({ path: pathSchema, query: Type.String({ minLength: 1 }), max_results: limitSchema }),
    async execute(_id, args, signal, _update, ctx) {
      const root = await realpath(resolve(ctx.cwd, args.path));
      const matches: { path: string; line: number; text: string }[] = [];
      const seen = new Set<string>(); let skipped_files = 0; let truncated = false;
      async function visit(path: string) {
        signal?.throwIfAborted();
        let target: string;
        try { target = await realpath(path); } catch { skipped_files++; return; }
        const rel = relative(root, target);
        if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) { skipped_files++; return; }
        if (seen.has(target)) return;
        seen.add(target);
        const info = await stat(target);
        if (info.isDirectory()) {
          for (const name of (await readdir(target)).sort()) { await visit(join(target, name)); if (truncated) break; }
          return;
        }
        if (!info.isFile() || info.size > 1024 * 1024) { skipped_files++; return; }
        let content: string;
        try { content = decode(await readFile(target)); } catch { skipped_files++; return; }
        for (const [index, text] of content.split("\n").entries()) if (text.includes(args.query)) {
          if (matches.length >= args.max_results) { truncated = true; return; }
          matches.push({ path, line: index + 1, text });
        }
      }
      await visit(root); return result({ matches, skipped_files, truncated });
    } });
  pi.registerTool({ name: "view_image", label: "View image", description: "View a local PNG, JPEG, GIF or WebP up to 20 MiB as image pixels. Convert other formats first.",
    parameters: Type.Object({ path: pathSchema }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted(); const path = resolve(ctx.cwd, args.path);
      const info = await stat(path);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Image must be a regular file up to 20 MiB");
      const bytes = await readFile(path);
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) ? "image/gif"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : undefined;
      if (!mimeType) throw new Error("Unsupported image format; expected PNG, JPEG, GIF or WebP");
      return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }], details: { path, bytes: bytes.length } };
    } });
}
