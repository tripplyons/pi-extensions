import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import manifest from "../package.json";

// npm test prepends the pinned development CLI, which may predate codemode.
const installedPath = process.env.PATH?.split(delimiter).filter(entry => !entry.endsWith("node_modules/.bin")).join(delimiter);
const version = spawnSync("pi", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: installedPath } });
const parts = version.stdout?.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
const supportsCodemode = version.status === 0 && parts && (Number(parts[1]) > 0 || Number(parts[2]) >= 99);

(supportsCodemode ? test : test.skip).each(["nested tools", "malformed image"])("installed Pi codemode safely handles %s without model requests", async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), "pi-codemode-"));
  const code = scenario === "nested tools"
    ? 'if (ALL_TOOLS.some(tool => tool.name === "swarm_complete")) throw new Error("Completion must remain a direct model tool"); await tools.write({path: "nested.txt", content: "verified nested tools"}); const values = await Promise.all([tools.read({path: "nested.txt"}), tools.grep({path: "nested.txt", pattern: "verified"}), tools.find({path: ".", pattern: "nested.txt"}), tools.ls({path: "."}), tools.future_tool({})]); for (const value of values) text(value);'
    : 'text("keep neighboring text"); image("data:image/jpeg;base64,montage: unable to read font\\n/9j/2Q==");';
  try {
    const agentDir = join(home, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultTools: ["+codemode"], codemode: { mode: "only" },
      retry: { enabled: false }, cacheWarming: "off",
    }));
    const probe = join(home, "probe.ts");
    await writeFile(probe, `
import { Type, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
export default function (pi) {
  let requests = 0;
  pi.registerTool({ name: "future_tool", label: "Future tool", description: "A plugin tool not in the old allowlist",
    parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "future tool survived" }] }; } });
  pi.registerProvider("codemode-test", {
    api: "openai-completions", apiKey: "test-key-never-sent", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
    streamSimple(model, context) {
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      if (JSON.stringify(names) !== '["codemode","swarm_complete"]') throw new Error("Unexpected model tools: " + JSON.stringify(names));
      requests++;
      if (requests > 2) throw new Error("Unexpected continuation");
      if (requests === 2) {
        const results = context.messages.filter(message => message.role === "toolResult");
        const scenario = ${JSON.stringify(scenario)};
        if (scenario === "nested tools" && (!JSON.stringify(results).includes("Script completed") || !JSON.stringify(results).includes("verified nested tools") || !JSON.stringify(results).includes("future tool survived")))
          throw new Error("Codemode did not execute the nested tools: " + JSON.stringify(results));
        if (scenario === "malformed image") {
          const result = results.find(message => message.toolCallId === "script");
          if (!result?.isError || result.content.some(block => block.type === "image") ||
            !JSON.stringify(result).includes("invalid image output") ||
            !JSON.stringify(result).includes("keep neighboring text"))
            throw new Error("Malformed image reached the provider: " + JSON.stringify(result));
        }
      }
      const content = requests === 1 ? [{ type: "toolCall", id: "script", name: "codemode", arguments: {
        code: ${JSON.stringify(code)}
      } }] : [{ type: "text", text: "codemode-only verified" }];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        stopReason: requests === 1 ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
}
`);
    const args = ["--offline", "--print", "--no-session", "--no-approve", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--provider", "codemode-test", "--model", "probe"];
    for (const entry of manifest.pi.extensions) args.push("--extension", resolve(import.meta.dir, "..", entry));
    args.push("--extension", probe, "Verify codemode-only nested tool execution.");
    const child = Bun.spawn(["pi", ...args], { cwd: home, env: {
      PATH: installedPath, HOME: home, TERM: "dumb", PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"),
    }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      expect(stdout).toContain("codemode-only verified");
      if (scenario === "nested tools") expect(await readFile(join(home, "nested.txt"), "utf8")).toBe("verified nested tools");
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
