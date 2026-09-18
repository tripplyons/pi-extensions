import { test, expect } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";

test("UTF-8 byte boundaries and binary rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-"));
  try {
    const h = harness(); h.ctx.cwd = root; install(h.pi);
    await writeFile(join(root, "a"), "héllo");
    expect((await h.call("read", { path: "a", offset: 1, limit: 2 })).details.content).toBe("é");
    await expect(h.call("read", { path: "a", offset: 2, limit: 1 })).rejects.toThrow("UTF-8");
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await expect(h.call("read", { path: "binary", offset: 0, limit: 2 })).rejects.toThrow("Binary");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("literal search skips unsafe files, bounds results and avoids link cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-search-"));
  try {
    const h = harness(); h.ctx.cwd = root; install(h.pi);
    await writeFile(join(root, "a"), "a.b\naXb\na.b\n");
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(join(root, "large"), "x".repeat(1024 * 1024 + 1));
    await symlink(tmpdir(), join(root, "outside"));
    await symlink(root, join(root, "cycle"));
    const searched = (await h.call("search", { path: ".", query: "a.b", max_results: 10 })).details;
    expect(searched.matches.map((m: any) => m.line)).toEqual([1, 3]);
    expect(searched.skipped_files).toBe(3);
    expect((await h.call("search", { path: ".", query: "a.b", max_results: 1 })).details.truncated).toBe(true);
    const listed = (await h.call("list", { path: ".", recursive: true, max_results: 2 })).details;
    expect(listed.entries).toHaveLength(2); expect(listed.truncated).toBe(true);
    const abort = new AbortController(); abort.abort();
    await expect(h.call("search", { path: ".", query: "x", max_results: 10 }, abort.signal)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("image tool returns actual pixels and rejects text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-image-"));
  try {
    const h = harness(); h.ctx.cwd = root; install(h.pi);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await writeFile(join(root, "image"), Buffer.from(png, "base64"));
    const response = await h.call("view_image", { path: "image" });
    expect(response.content[0]).toEqual({ type: "image", data: png, mimeType: "image/png" });
    await writeFile(join(root, "text"), "not an image");
    await expect(h.call("view_image", { path: "text" })).rejects.toThrow("Unsupported");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("removes built-in write and edit without disabling other tools", async () => {
  const h = harness();
  let active = ["read", "edit", "write", "bash", "shell", "search"];
  h.pi.getActiveTools = () => active;
  h.pi.setActiveTools = (names: string[]) => { active = names; };
  install(h.pi);
  expect(h.tools.has("edit")).toBe(false);
  expect(h.tools.has("write")).toBe(false);
  await h.emit("session_start");
  expect(active).toEqual(["read", "bash", "shell", "search"]);
});
