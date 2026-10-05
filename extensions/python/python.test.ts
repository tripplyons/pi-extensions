import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { harness } from "../../lib/harness.ts";
import { Tasks, registerTaskTools, taskKey } from "../tasks/tasks.ts";
import python, { scriptMetadata } from "./index.ts";

const header = '# /// script\n# requires-python = ">=3.11"\n# dependencies = []\n# ///\n';
const code = header + 'print("hello")\n';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup(managed = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-python-'test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  cleanup.push(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const h = harness();
  h.ctx.cwd = root;
  h.ctx.isIdle = () => false;
  const calls: any[] = [];
  Object.defineProperty(h.ctx, "tools", { get: () => [...h.tools.values()] });
  h.ctx.executeTool = async (name: string, args: unknown, options: any) => {
    calls.push({ name, args, options });
    const result = await h.call(name, args, options.signal);
    return { result, isError: result.isError === true };
  };
  python(h.pi);
  let tasks: Tasks | undefined;
  if (managed) {
    tasks = new Tasks(join(root, "tasks"));
    registerTaskTools(h.pi, tasks);
    cleanup.push(() => h.emit("session_shutdown"));
  } else h.tools.set("bash", {
    name: "bash", parameters: { properties: { run_in_background: {} } },
    execute: async () => ({ content: [{ type: "text", text: "started" }], details: { task_id: "test-task", status: "started" } }),
  });
  return { root, h, calls, tasks };
}

async function settled(tasks: Tasks, id: string) {
  for (let i = 0; i < 200; i++) {
    const task = tasks.query(id);
    if (!["running", "stopping"].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Python task did not finish within 4 seconds");
}

test("metadata accepts PEP 723, CRLF, multiline dependencies, and other metadata types", () => {
  expect(scriptMetadata(code)).toMatchObject({ "requires-python": ">=3.11", dependencies: [] });
  expect(scriptMetadata(code.replaceAll("\n", "\r\n"))).toMatchObject({ dependencies: [] });
  expect(scriptMetadata('# /// other\n# value = 1\n# ///\n' + header.replace("dependencies = []", 'dependencies = [\n#   "httpx>=0.28,<1",\n# ]'))).toMatchObject({ dependencies: ["httpx>=0.28,<1"] });
});

for (const [label, source] of [
  ["blank code", " "],
  ["missing block", 'print("hello")'],
  ["unclosed block", '# /// script\n# requires-python = ">=3.11"\n'],
  ["duplicate blocks", header + header],
  ["malformed second block", header + '# /// script\n# dependencies = []'],
  ["invalid TOML", header.replace("[]", "[")],
  ["missing Python version", header.replace('# requires-python = ">=3.11"\n', "")],
  ["blank Python version", header.replace(">=3.11", "")],
  ["nonstring Python version", header.replace('\">=3.11\"', "311")],
  ["missing dependencies", header.replace("# dependencies = []\n", "")],
  ["nonarray dependencies", header.replace("[]", '"httpx"')],
  ["nonstring dependency", header.replace("[]", "[123]")],
  ["blank dependency", header.replace("[]", '[" "]')],
  ["fields inside a table", header.replace('# requires-python', '# [tool.example]\n# requires-python')],
  ["fields inside a multiline string", '# /// script\n# fake = """\n# requires-python = ">=3.11"\n# dependencies = []\n# """\n# ///\n'],
] as const) test(`rejects ${label} before launching or saving a script`, async () => {
  const { h, root, calls } = await setup();
  await expect(h.call("python", { code: source })).rejects.toThrow();
  expect(calls).toHaveLength(0);
  expect(await readdir(root)).toEqual([]);
});

test("saves private source outside cwd and delegates an immediate managed background launch", async () => {
  const { h, root, calls } = await setup();
  const reply = await h.call("python", { code, args: ["space arg", "$(touch injected)", "a'b", "--option"], timeout: 42 });
  expect(reply.details).toMatchObject({ task_id: "test-task", status: "started" });
  expect(reply.details.script_path).toStartWith(join(root, "python", "scripts"));
  expect(await readFile(reply.details.script_path, "utf8")).toBe(code);
  expect((await stat(reply.details.script_path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "python", "scripts"))).mode & 0o777).toBe(0o700);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "bash", args: { run_in_background: true, timeout: 42 } });
  expect(calls[0].args.command).toContain("PYTHONUNBUFFERED=1 uv run --no-project --script");
  expect(calls[0].args.command).toContain("'space arg' '$(touch injected)' 'a'\\''b' '--option'");
});

test("requires managed Bash and rejects NUL arguments before writing source", async () => {
  const { h, root } = await setup();
  h.tools.delete("bash");
  await expect(h.call("python", { code })).rejects.toThrow("tasks extension");
  h.tools.set("bash", { name: "bash", parameters: { properties: {} } });
  await expect(h.call("python", { code })).rejects.toThrow("tasks extension");
  h.tools.set("bash", { name: "bash", parameters: { properties: { run_in_background: {} } } });
  await expect(h.call("python", { code, args: ["\0"] })).rejects.toThrow("NUL");
  expect(await readdir(root)).toEqual([]);
});

test("blocked nested calls remain errors and remove unused source", async () => {
  const { h, root } = await setup();
  h.ctx.executeTool = async () => ({ isError: true, result: { content: [{ type: "text", text: "Permission denied" }], details: undefined } });
  const reply = await h.call("python", { code });
  expect(reply.isError).toBe(true);
  expect(reply.content[0].text).toBe("Permission denied");
  expect(await readdir(join(root, "python", "scripts"))).toEqual([]);
});

test("already canceled calls do not save source or launch tasks", async () => {
  const { h, root, calls } = await setup();
  const controller = new AbortController(); controller.abort();
  await expect(h.call("python", { code }, controller.signal)).rejects.toThrow();
  expect(calls).toHaveLength(0);
  expect(await readdir(root)).toEqual([]);
});

test.skipIf(!Bun.which("uv"))("real uv tasks preserve cwd, literal args, Python constraints, and launch-turn independence", async () => {
  const { h, root, tasks } = await setup(true);
  const controller = new AbortController();
  const args = ["space arg", "$(touch injected)", "a'b", "--option"];
  const source = header + 'import json, os, sys, time\ntime.sleep(0.1)\nprint(json.dumps({"cwd": os.getcwd(), "args": sys.argv[1:], "version": list(sys.version_info[:2])}))\n';
  const reply = await h.call("python", { code: source, args }, controller.signal);
  controller.abort();
  expect(reply.details.status).toBe("started");
  const id = reply.details.task_id;
  expect(h.entries.find(entry => entry.customType === taskKey).data).toBe(id);
  expect(Date.parse(tasks!.query(id).deadline_at!) - Date.parse(tasks!.query(id).created_at)).toBeGreaterThanOrEqual(1_799_000);
  expect((await settled(tasks!, id)).status).toBe("succeeded");
  const output = (await h.call("task_output", { task_id: id })).details.output;
  const payload = JSON.parse(output.trim().split("\n").at(-1));
  expect(payload.cwd).toBe(await realpath(root));
  expect(payload.args).toEqual(args);
  expect(payload.version[0]).toBe(3);
  expect(payload.version[1]).toBeGreaterThanOrEqual(11);
  expect(await readdir(root)).not.toContain("injected");
  expect(await readdir(root)).not.toContain(".venv");
  expect(await readFile(reply.details.script_path, "utf8")).toBe(source);
  expect((await h.call("task_query", { task_id: id })).details.status).toBe("succeeded");
  const minor = payload.version[1];
  const constrained = header.replace(">=3.11", `>=3.${minor},<3.${minor + 1}`) + 'import sys\nprint(sys.version_info.minor)\n';
  const selected = await h.call("python", { code: constrained });
  expect((await settled(tasks!, selected.details.task_id)).status).toBe("succeeded");
  expect((await h.call("task_output", { task_id: selected.details.task_id })).details.output.trim()).toBe(String(minor));
});

test.skipIf(!Bun.which("uv"))("uv installs a script's inline dependency without a project or network", async () => {
  const { h, root, tasks } = await setup(true);
  const wheel = join(root, "pi_python_fixture-1.0.0-py3-none-any.whl");
  const files = {
    "pi_python_fixture.py": 'VALUE = "inline dependency loaded"\n',
    "pi_python_fixture-1.0.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: pi-python-fixture\nVersion: 1.0.0\n",
    "pi_python_fixture-1.0.0.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: python-tool-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    "pi_python_fixture-1.0.0.dist-info/RECORD": "",
  };
  const builder = header + `import json, zipfile\nfiles = json.loads(${JSON.stringify(JSON.stringify(files))})\nwith zipfile.ZipFile(${JSON.stringify(wheel)}, "w") as archive:\n    for name, content in files.items():\n        archive.writestr(name, content)\n`;
  const built = await h.call("python", { code: builder });
  expect((await settled(tasks!, built.details.task_id)).status).toBe("succeeded");
  const dependency = `pi-python-fixture @ ${new URL(`file://${wheel}`).href}`;
  const source = header.replace("dependencies = []", `dependencies = [${JSON.stringify(dependency)}]`) + 'import pi_python_fixture\nprint(pi_python_fixture.VALUE)\n';
  const launched = await h.call("python", { code: source });
  const record = await settled(tasks!, launched.details.task_id);
  const output = (await h.call("task_output", { task_id: launched.details.task_id })).details.output;
  expect({ status: record.status, output }).toMatchObject({ status: "succeeded", output: expect.stringContaining("inline dependency loaded") });
  expect(await readdir(root)).not.toContain(".venv");
  expect(await readdir(root)).not.toContain("uv.lock");
});

test.skipIf(!Bun.which("uv"))("script errors, timeouts, and stop use the existing task controls", async () => {
  const { h, tasks } = await setup(true);
  const failed = await h.call("python", { code: header + 'raise RuntimeError("script failed")\n' });
  expect((await settled(tasks!, failed.details.task_id)).status).toBe("failed");
  expect((await h.call("task_output", { task_id: failed.details.task_id })).details.output).toContain("RuntimeError: script failed");
  for (const invalid of [header.replace(">=3.11", "not-a-version"), header.replace("[]", '["=="]')]) {
    const launched = await h.call("python", { code: invalid + 'print("must not run")\n' });
    expect((await settled(tasks!, launched.details.task_id)).status).toBe("failed");
    const output = (await h.call("task_output", { task_id: launched.details.task_id })).details.output;
    expect(output).toContain("error:");
    expect(output).not.toContain("must not run");
  }
  const expired = await h.call("python", { code: header + 'import time\ntime.sleep(30)\n', timeout: 0.1 });
  const expiredRecord = await settled(tasks!, expired.details.task_id);
  expect(expiredRecord.status).toBe("failed");
  expect(expiredRecord.error).toContain("timed out");
  const stopped = await h.call("python", { code: header + 'import time\ntime.sleep(30)\n' });
  expect((await h.call("task_stop", { task_id: stopped.details.task_id })).details.status).toBe("canceled");
  expect(tasks!.query(stopped.details.task_id).status).toBe("canceled");
});

test("compact Python preview is bounded and expanded preview retains source", async () => {
  const { h } = await setup();
  const tool = h.tools.get("python");
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const collapsed = tool.renderCall({ code, timeout: 42 }, theme, { expanded: false }).render(100);
  expect(collapsed).toHaveLength(1);
  expect(collapsed[0]).toContain("background, 42s deadline");
  expect(collapsed[0]).not.toContain("requires-python");
  const narrow = tool.renderCall({ code }, theme, { expanded: false }).render(20);
  expect(visibleWidth(narrow[0])).toBeLessThanOrEqual(20);
  const expanded = tool.renderCall({ code }, theme, { expanded: true }).render(100).join("\n");
  expect(expanded).toContain("requires-python");
  expect(expanded).toContain('print("hello")');
});
