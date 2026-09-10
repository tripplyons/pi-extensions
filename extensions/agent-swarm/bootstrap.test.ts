import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxProfile } from "./isolation.ts";
import { HOST_RELEASE } from "@howaboua/pi-codex-conversion/dist/tools/code-mode/host-assets.js";

const macTest = process.platform === "darwin" && process.env.PI_SWARM_TEST_CODE_HOST ? test : test.skip;

macTest("installed Pi and conversion start offline with private configuration under the sandbox", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-bootstrap-")));
	const [worktree, workerHome, workerTmp, outbox, inbox] = ["worktree", "home", "tmp", "outbox", "inbox"].map((name) => join(root, name));
	for (const path of [worktree, workerHome, workerTmp, outbox, inbox]) mkdirSync(path);
	const cli = realpathSync(spawnSync("which", ["pi"], { encoding: "utf8" }).stdout.trim());
	const conversion = realpathSync(fileURLToPath(import.meta.resolve("@howaboua/pi-codex-conversion")));
	const swarm = realpathSync(fileURLToPath(new URL("./index.ts", import.meta.url)));
	const complain = realpathSync(fileURLToPath(new URL("../complain/index.ts", import.meta.url)));
	const node = realpathSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim());
	const agentDir = join(workerHome, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-codex-conversion.json"), JSON.stringify({ executionMode: "code" }));
	const hostDirectory = join(agentDir, "cache", "pi-codex-conversion", "code-mode", HOST_RELEASE, `${process.platform}-${process.arch}`);
	mkdirSync(hostDirectory, { recursive: true });
	copyFileSync(process.env.PI_SWARM_TEST_CODE_HOST!, join(hostDirectory, "codex-code-mode-host"));
	const fixture = join(workerHome, "fixture.ts");
	const probeFile = join(outbox, "probe.json");
	const complaintFile = join(outbox, "complaints.jsonl");
	writeFileSync(fixture, `
		import conversion from ${JSON.stringify(conversion)};
		import loadComplain from ${JSON.stringify(complain)};
		import { writeFileSync } from 'node:fs';
		export default async (pi) => {
			let exec; let complain;
			const register = pi.registerTool.bind(pi);
			pi.registerTool = (tool) => { if (tool.name === 'exec') exec = tool; if (tool.name === 'complain') complain = tool; register(tool); };
			await conversion(pi);
			loadComplain(pi);
			pi.on('session_start', async (_event, ctx) => {
				const result = await exec.execute('probe-code', {code:'text(6 * 7)'}, new AbortController().signal, undefined, ctx);
				const shell = await exec.execute('probe-shell', {code:'text(await tools.exec_command({cmd:"printf sandboxed > code-owned"}))'}, new AbortController().signal, undefined, ctx);
				await complain.execute('probe-complain', {message:'Sandbox complaint'}, new AbortController().signal, undefined, ctx);
				writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({tools:pi.getActiveTools(), allTools:pi.getAllTools().map(tool => tool.name), result, shell}));
			});
		};
	`);
	const profile = join(root, "profile.sb");
	try {
		writeFileSync(profile, sandboxProfile({
			worktree, workerHome, workerTmp, outbox, inbox, stateRoot: root,
			coordinatorWorktree: join(root, "coordinator"), gitCommonDir: join(root, "git-common"),
			hostHome: join(root, "host-home"), sourceAgentDir: join(root, "host-home", ".pi", "agent"),
		}));
		const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, node, cli,
			"--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
			"--no-context-files", "--no-approve", "--no-session", "--model", "openai-codex/gpt-5.4", "--extension", swarm, "--extension", fixture,
		], {
			cwd: worktree, env: { HOME: workerHome, TMPDIR: workerTmp, PI_CODING_AGENT_DIR: agentDir, PI_SWARM_HOME: join(root, "swarm-state"), PI_COMPLAIN_LOG: complaintFile, PATH: `${dirname(node)}:/usr/bin:/bin` },
			input: '{"id":"probe","type":"get_state"}\n', encoding: "utf8", timeout: 10000,
		});
		if (result.status !== 0) throw new Error(`Sandboxed Pi startup failed: ${result.error?.message ?? result.stderr}`);
		const events = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const response = events.find((item) => item.id === "probe");
		expect(response?.success).toBe(true);
		let probe;
		try { probe = JSON.parse(readFileSync(probeFile, "utf8")); }
		catch { throw new Error(`Code fixture did not finish: ${result.stderr}\n${result.stdout}`); }
		const tools = probe.tools;
		expect(tools).toContain("exec");
		expect(tools).toContain("wait");
		expect(probe.allTools).toContain("swarm_spawn");
		expect(tools).toContain("complain");
		expect(tools).not.toContain("subagent");
		expect(JSON.stringify(probe.result.content)).toContain("42");
		expect(readFileSync(join(worktree, "code-owned"), "utf8")).toBe("sandboxed");
		expect(JSON.parse(readFileSync(complaintFile, "utf8")).message).toBe("Sandbox complaint");
		expect(result.stderr).not.toContain("Failed to load extension");
	} finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
