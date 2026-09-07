import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const piAvailable = Bun.which("pi") !== null;

test.skipIf(!piAvailable).each(["ordinary", "goal", "progress", "progress-pass"])("real Pi RPC runs fusion: %s", async (mode) => {
	const goal = mode === "goal";
	const progress = mode.startsWith("progress");
	const directory = await mkdtemp(join(tmpdir(), "fusion-rpc-"));
	const requests: any[] = [];
	let actorTurns = 0;
	let releaseReview: () => void = () => {};
	const actorContinued = new Promise<void>((resolve) => { releaseReview = resolve; });
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
		const body: any = await request.json();
		requests.push(body);
		let delta: any;
		let finish = "stop";
		if (body.model === "actor") {
			actorTurns++;
			if (progress && actorTurns === 11) {
				releaseReview();
				const deadline = Date.now() + 3000;
				while (!events.some((event) => event.method === "notify" && event.message?.includes("Fusion: progress review")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			if (goal && actorTurns === 1) {
				delta = { role: "assistant", tool_calls: [{ index: 0, id: "create-goal", type: "function", function: { name: "create_goal", arguments: JSON.stringify({ objective: "Write and verify result.txt" }) } }] };
				finish = "tool_calls";
			} else if ((progress ? actorTurns <= 11 : actorTurns === (goal ? 2 : 1))) {
				delta = { role: "assistant", tool_calls: [{ index: 0, id: "write-fixture", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "real tool executed\n" }) } }] };
				finish = "tool_calls";
			} else if (goal && actorTurns === 3) {
				delta = { role: "assistant", content: "Fixture written; the goal still needs its final check." };
			} else if (goal) {
				delta = { role: "assistant", tool_calls: [{ index: 0, id: `complete-${actorTurns}`, type: "function", function: { name: "update_goal", arguments: JSON.stringify({ status: "complete" }) } }] };
				finish = "tool_calls";
			} else delta = { role: "assistant", content: "Candidate implementation complete." };
		} else if (body.model === "frontier") delta = { role: "assistant", content: "Check the fixture and report remaining uncertainty." };
		else {
			if (progress) await actorContinued;
			const passing = (goal && actorTurns === 3) || (mode === "progress-pass" && actorTurns <= 11);
			delta = { role: "assistant", content: JSON.stringify({ verdict: passing ? "pass" : "revise", findings: passing ? [] : ["The candidate has not demonstrated the requested check."], checks: ["Inspect the fixture."] }) };
		}
		const chunk = (choices: any[], usage?: any) => ({ id: "completion", object: "chat.completion.chunk", created: 1, model: body.model, choices, ...(usage ? { usage } : {}) });
		const frames = [chunk([{ index: 0, delta, finish_reason: null }]), chunk([{ index: 0, delta: {}, finish_reason: finish }], { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 })];
		return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	} });
	const slot = (model: string) => ({ provider: "fusion-test", model, reasoning: "off" });
	await writeFile(join(directory, "model-fusion.json"), JSON.stringify({ actor: slot("actor"), reviewers: [slot("reviewer-a"), slot("reviewer-b")], frontier: slot("frontier") }));
	await writeFile(join(directory, "provider.ts"), `export default function(pi) { pi.registerProvider("fusion-test", { baseUrl: "http://127.0.0.1:${server.port}/v1", apiKey: "test-only", api: "openai-completions", models: ${JSON.stringify(["actor", "reviewer-a", "reviewer-b", "frontier"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })))} }); }`);
	const args = ["--mode", "rpc", "--session-dir", join(directory, "sessions"), "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--offline", "--provider", "fusion-test", "--model", "actor", "-e", join(directory, "provider.ts"), "-e", fileURLToPath(new URL("./index.ts", import.meta.url)), ...(goal ? ["-e", fileURLToPath(new URL("../goal/index.ts", import.meta.url))] : [])];
	const launch = (resume = false) => spawn("pi", [...args, ...(resume ? ["--continue"] : [])], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
	let child = launch();
	const events: any[] = [];
	let stderr = "";
	let buffer = "";
	const attach = () => {
	child.stderr.on("data", (data) => { stderr += data; });
	child.stdout.on("data", (data) => {
		buffer += data.toString();
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n");
			const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
			try { events.push(JSON.parse(line)); } catch { /* Startup text is not a protocol event. */ }
		}
	});
	};
	attach();
	const send = (command: any) => child.stdin.write(JSON.stringify(command) + "\n");
	const wait = async (predicate: (event: any) => boolean) => {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const found = events.find(predicate);
			if (found) return found;
			if (child.exitCode !== null) throw new Error(`Pi exited: ${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`RPC event timeout: ${stderr}\n${JSON.stringify(events.slice(-5))}`);
	};
	try {
		send({ id: "on", type: "prompt", message: "/fusion on" });
		expect((await wait((event) => event.id === "on")).success).toBe(true);
		send({ id: "task", type: "prompt", message: "Write result.txt and verify the result." });
		if (goal) await wait((event) => event.type === "tool_execution_end" && event.toolName === "update_goal" && event.result?.terminate);
		else await wait((event) => event.type === "agent_settled");
		expect(events.filter((event) => event.type === "extension_error")).toEqual([]);
		expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("real tool executed\n");
		expect(actorTurns).toBe(goal ? 6 : progress ? 14 : 4);
		if (mode === "progress") expect(JSON.stringify(requests.filter((request) => request.model === "actor")[11].messages)).toContain("Background progress review: findings");
		if (mode === "progress-pass") expect(events.some((event) => event.type === "message_start" && event.message?.customType === "model-fusion" && event.message.content.includes("Background progress review: passed"))).toBe(true);
		if (goal) {
			const results = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "update_goal");
			expect(results).toHaveLength(3);
			expect(results.slice(0, 2).every((event) => event.isError)).toBe(true);
			expect(results[2].result.terminate).toBe(true);
		}
		expect(requests.filter((request) => request.model === "reviewer-a")).toHaveLength(goal || progress ? 3 : 2);
		expect(requests.filter((request) => request.model === "reviewer-b")).toHaveLength(goal || progress ? 3 : 2);
		expect(requests.filter((request) => request.model === "frontier")).toHaveLength(1);
		for (const request of requests.filter((request) => request.model !== "actor")) expect(request.tools ?? []).toHaveLength(0);
		expect(events.some((event) => event.method === "notify" && event.message?.includes("bounded review cycle ended"))).toBe(true);
		if (mode === "ordinary") {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			events.length = 0; buffer = "";
			child = launch(true); attach();
			send({ id: "restored", type: "prompt", message: "/fusion status" });
			expect((await wait((event) => event.id === "restored")).success).toBe(true);
			expect(events.some((event) => event.method === "notify" && event.message?.startsWith("Fusion on;"))).toBe(true);
		}
	} finally {
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
