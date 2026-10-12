import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import actionFusion, { assertUnchanged, resolveToolPath } from "./index.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "action-fusion-"));
  dirs.push(dir);
  const h = harness();
  h.ctx.cwd = dir;
  actionFusion(h.pi);
  return { dir, h };
}

const output = (result: any) => result.content.map((block: any) => block.text).join("\n");

test("edit and write keep their built-in parameters and add an optional then_run", async () => {
  const { h } = await setup();
  for (const [name, keys] of [["edit", ["path", "edits", "then_run"]], ["write", ["path", "content", "then_run"]]] as const) {
    const schema = h.tools.get(name).parameters;
    expect(Object.keys(schema.properties)).toEqual([...keys]);
    expect(schema.required).not.toContain("then_run");
    expect(schema.properties.then_run.required).toEqual(["command"]);
  }
});

test("write runs the command after the content is visible", async () => {
  const { dir, h } = await setup();
  const result = await h.call("write", { path: "a.txt", content: "new\n", then_run: { command: "cat a.txt" } });
  expect(output(result)).toContain("[then_run:succeeded]\nnew");
  expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new\n");
});

test("edit runs the command after the edit", async () => {
  const { dir, h } = await setup();
  await writeFile(join(dir, "a.txt"), "before\n");
  const result = await h.call("edit", { path: "a.txt", edits: [{ oldText: "before", newText: "after" }], then_run: { command: "cat a.txt" } });
  expect(output(result)).toContain("[then_run:succeeded]\nafter");
});

test("a mutation without then_run returns the built-in result", async () => {
  const { h } = await setup();
  expect(output(await h.call("write", { path: "a.txt", content: "plain\n" }))).not.toContain("[then_run:");
});

test("a failing command keeps the mutation and reports the failure", async () => {
  const { dir, h } = await setup();
  const result = await h.call("write", { path: "a.txt", content: "keep\n", then_run: { command: "echo broken; exit 7" } });
  expect(result.isError).toBe(true);
  expect(output(result)).toMatch(/\[then_run:failed\]\nbroken[\s\S]*code 7/);
  expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("keep\n");
});

test("a failed mutation skips the command", async () => {
  const { dir, h } = await setup();
  await expect(h.call("edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }], then_run: { command: "touch ran" } }))
    .rejects.toThrow("[then_run:skipped]");
  await expect(readFile(join(dir, "ran"))).rejects.toThrow();
});

test("the file stays locked until its command finishes", async () => {
  const { dir, h } = await setup();
  const first = h.call("write", { path: "a.txt", content: "first\n", then_run: { command: "sleep 0.2; cat a.txt" } });
  await new Promise(done => setTimeout(done, 50));
  const second = h.call("write", { path: "a.txt", content: "second\n" });
  expect(output(await first)).toContain("[then_run:succeeded]\nfirst");
  await second;
  expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("second\n");
});

test("symlinked paths share one lock", async () => {
  const { dir, h } = await setup();
  await symlink(dir, join(dir, "alias"));
  const first = h.call("write", { path: "a.txt", content: "first\n", then_run: { command: "sleep 0.2; cat a.txt" } });
  await new Promise(done => setTimeout(done, 50));
  const second = h.call("write", { path: "alias/a.txt", content: "second\n" });
  expect(output(await first)).toContain("first");
  await second;
});

test("the timeout reaches Bash", async () => {
  const { h } = await setup();
  const result = await h.call("write", { path: "a.txt", content: "x", then_run: { command: "sleep 5", timeout: 0.1 } });
  expect(result.isError).toBe(true);
  expect(output(result)).toMatch(/\[then_run:failed\][\s\S]*timed out/i);
});

test("a change after the mutation skips the command", async () => {
  const { dir } = await setup();
  const path = join(dir, "a.txt");
  await writeFile(path, "mutation\n");
  await expect(assertUnchanged(path, () => writeFile(path, "external\n")))
    .rejects.toThrow("[then_run:skipped] target content changed after the fused mutation");
});

test("paths resolve like Pi's built-in tools", () => {
  const target = join(tmpdir(), "space and #hash %.txt");
  expect(resolveToolPath("/cwd", pathToFileURL(target).href)).toBe(target);
  expect(resolveToolPath("/cwd", `@${pathToFileURL(target).href}`)).toBe(target);
  expect(resolveToolPath("/cwd", "~/a.txt")).toBe(join(homedir(), "a.txt"));
  expect(resolveToolPath("/cwd", "@a b.txt")).toBe("/cwd/a b.txt");
});
