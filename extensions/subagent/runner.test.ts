import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startAgentRun } from "./runner.ts";

test("real Pi child activates native files and bg-bash before prompting and can be cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-native-child-"));
  const agentDir = join(dir, "agent");
  const originalScript = process.argv[1];
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let run;
  try {
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(agentDir, "pi-codex-conversion.json"), JSON.stringify({
      executionMode: "normal",
      voiceFeaturesOnly: true,
      tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
      compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false },
    }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false });
    const model = modelRuntime.getModels("openai-codex")[0];
    const probe = join(dir, "probe.ts");
    await writeFile(probe, `export default function(pi) {
      pi.on("session_start", async () => {
        console.log(JSON.stringify({ type: "message_end", message: {
          role: "assistant", content: [{ type: "text", text: JSON.stringify(pi.getActiveTools()) }]
        }}));
        // Hold before any model request so the parent can test cancellation.
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    }`);
    const wrapper = join(dir, "pi.mjs");
    const cli = new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
    await writeFile(wrapper, `process.argv.splice(process.argv.length - 1, 0, "--extension", ${JSON.stringify(probe)}); await import(${JSON.stringify(cli)});`);
    process.argv[1] = wrapper;
    run = startAgentRun({ task: "No model request", cwd: dir, model: `${model.provider}/${model.id}`, thinking: "off" });
    const deadline = Date.now() + 15_000;
    while (!run.snapshot().output && run.snapshot().status === "running" && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    const snapshot = run.snapshot();
    expect(snapshot.stderr).not.toContain("Failed to load extension");
    expect(snapshot.output).not.toBe("");
    const tools = JSON.parse(snapshot.output);
    expect(tools.sort()).toEqual(["bash", "bg_process", "edit", "read", "sleep", "write"].sort());
    const stopped = await run.kill();
    expect(stopped.status).toBe("killed");
    expect(() => process.kill(snapshot.pid, 0)).toThrow();
  } finally {
    await run?.kill();
    process.argv[1] = originalScript;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);
