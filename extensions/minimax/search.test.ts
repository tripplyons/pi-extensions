import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "../../lib/harness.ts";
import { registerSearchTools } from "./search.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const h = harness();
  h.ctx.cwd = await mkdtemp(join(tmpdir(), "minimax-search-")); roots.push(h.ctx.cwd);
  registerSearchTools(h.pi);
  await mkdir(join(h.ctx.cwd, ".git"));
  await writeFile(join(h.ctx.cwd, "a.txt"), "needle one\nneedle two\nother\n");
  await writeFile(join(h.ctx.cwd, "b.txt"), "needle three\n");
  return h;
}
const text = (output: any) => output.content[0].text;

test("grep pages content, filenames and per-file matching-line counts", async () => {
  const h = await setup();
  const first = await h.call("grep", { pattern: "needle", limit: 1 });
  expect(text(first)).toContain("needle one"); expect(first.details.next_offset).toBe(1);
  const second = await h.call("grep", { pattern: "needle", offset: 1, limit: 1 });
  expect(text(second)).toContain("needle two"); expect(second.details.next_offset).toBe(2);
  const last = await h.call("grep", { pattern: "needle", offset: 2, limit: 1 });
  expect(text(last)).toContain("needle three"); expect(last.details.next_offset).toBeNull();
  const files = await h.call("grep", { pattern: "needle", mode: "files", limit: 1 });
  expect(text(files)).toContain("a.txt"); expect(text(files)).not.toContain("needle"); expect(files.details.next_offset).toBe(1);
  const count = await h.call("grep", { pattern: "needle", mode: "count" });
  expect(text(count)).toContain('a.txt":2'); expect(text(count)).toContain('b.txt":1');
  expect(text(await h.call("grep", { pattern: "NEEDLE", literal: true, ignoreCase: true, glob: "b*" }))).toContain("needle three");
});

test("glob pages stable paths, supports newest first and scoped ignored searches", async () => {
  const h = await setup();
  await writeFile(join(h.ctx.cwd, ".gitignore"), "ignored/\n");
  await mkdir(join(h.ctx.cwd, "ignored")); await writeFile(join(h.ctx.cwd, "ignored", "hidden.txt"), "needle\n");
  const first = await h.call("glob", { pattern: "*.txt", limit: 1 });
  expect(text(first)).toContain("a.txt"); expect(first.details.next_offset).toBe(1);
  const last = await h.call("glob", { pattern: "*.txt", offset: 1 });
  expect(text(last)).toContain("b.txt"); expect(text(last)).not.toContain("hidden"); expect(last.details.next_offset).toBeNull();
  await utimes(join(h.ctx.cwd, "a.txt"), 100, 100);
  expect(text(await h.call("glob", { pattern: "*.txt", sort: "modified", limit: 1 }))).toContain("b.txt");
  expect(text(await h.call("grep", { pattern: "needle", mode: "files" }))).not.toContain("hidden.txt");
  expect(text(await h.call("grep", { pattern: "needle", path: "ignored", includeIgnored: true }))).toContain("hidden.txt");
  await expect(h.call("glob", { pattern: "*", includeIgnored: true })).rejects.toThrow("explicit scoped path");
});

test("search reports errors, cancellation, empty pages and empty history", async () => {
  const h = await setup();
  await expect(h.call("grep", { pattern: "[" })).rejects.toThrow();
  await expect(h.call("grep", { pattern: "x", path: "missing" })).rejects.toThrow();
  expect(text(await h.call("grep", { pattern: "absent" }))).toContain("No results");
  expect((await h.call("glob", { pattern: "*", offset: 100 })).details.next_offset).toBeNull();
  const abort = new AbortController(); abort.abort();
  await expect(h.call("grep", { pattern: "needle" }, abort.signal)).rejects.toThrow();
});

test("content pages preserve context records and bound Unicode output by bytes", async () => {
  const h = await setup();
  const context = await h.call("grep", { pattern: "two", context: 1, limit: 2 });
  expect(text(context)).toContain("needle one"); expect(text(context)).toContain("needle two");
  expect(context.details.next_offset).toBe(2);
  expect(text(await h.call("grep", { pattern: "two", context: 1, offset: 2 }))).toContain("other");
  await writeFile(join(h.ctx.cwd, "large.txt"), Array.from({ length: 200 }, (_, i) => `${i} ${"界".repeat(600)}\n`).join(""));
  const page = await h.call("grep", { path: "large.txt", pattern: "界", limit: 1000 });
  expect(Buffer.byteLength(text(page))).toBeLessThan(50 * 1024);
  expect(page.details.next_offset).toBeGreaterThan(0); expect(page.details.next_offset).toBeLessThan(200);
  expect(text(page)).toContain("line truncated; use read"); expect(text(page)).not.toContain("�");
  const next = await h.call("grep", { path: "large.txt", pattern: "界", offset: page.details.next_offset });
  expect(text(next)).toContain(`:${page.details.next_offset + 1}:`);
});
