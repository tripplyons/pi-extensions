import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchWorker } from "./worker.ts";
import { emptyUsage, type Attempt, type CommandResult } from "./state.ts";

const fake = `
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', chunk => {
 buffer += chunk;
 let newline;
 while ((newline = buffer.indexOf('\\n')) >= 0) {
  const command = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
  if (command.type === 'get_session_stats') {
   setTimeout(() => emit({type:'response',id:command.id,success:true,data:{tokens:{input:12,output:8,cacheRead:3,cacheWrite:2,total:25},cost:0.2,assistantMessages:2}}), 50); continue;
  }
  emit({type:'response',id:command.id,success:true});
  if (command.id === 'initial') emit({type:'agent_settled'});
  emit({type:'turn_start'});
  if (command.message === 'hang') continue;
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:command.message}],stopReason:'stop',usage:{input:6,output:4}}});
  emit({type:'agent_end'});
  if (command.message !== 'wait for steering') setTimeout(() => emit({type:'agent_settled'}), 30);
 }
});
`;

function worker(task: string, timeoutMs = 3000) {
	const home = mkdtempSync(join(tmpdir(), "mixture-rpc-"));
	const attempt: Attempt = { attempt: 1, status: "queued", startedAt: Date.now(), output: "", usage: emptyUsage(), logFile: join(home, "events.jsonl"), sessionFile: join(home, "session.jsonl") };
	let complete!: () => void;
	const done = new Promise<void>((resolve) => { complete = resolve; });
	const controller = launchWorker({ command: process.execPath, args: ["-e", fake], cwd: home, env: process.env, task, timeoutMs }, attempt, () => {}, complete);
	return { attempt, controller, done };
}

test("RPC output and authoritative usage survive process exit", async () => {
	const { attempt, done } = worker("391");
	await done;
	expect(attempt.status).toBe("ok");
	expect(attempt.output).toBe("391");
	expect(attempt.usage).toEqual({ input: 12, output: 8, cacheRead: 3, cacheWrite: 2, cost: 0.2, turns: 2 });
	expect(readFileSync(attempt.logFile, "utf8")).toContain("agent_settled");
});

test("agent_end does not terminate a worker that can still accept steering", async () => {
	const { attempt, controller, done } = worker("wait for steering");
	for (let i = 0; i < 100 && !attempt.output; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(attempt.status).toBe("running");
	const command: CommandResult = { id: "steer", action: "send", message: "changed direction", session: "root", createdAt: Date.now(), status: "pending" };
	controller.send(command);
	await done;
	expect(command.status).toBe("accepted");
	expect(attempt.output).toContain("changed direction");
});

test("timeout terminates a real worker process", async () => {
	const { attempt, done } = worker("hang", 100);
	await done;
	expect(attempt.status).toBe("timeout");
	expect(() => process.kill(attempt.pid!, 0)).toThrow();
});

test("steering is rejected while settled usage is being fetched", async () => {
	const { attempt, controller, done } = worker("391");
	for (let i = 0; i < 100; i++) {
		let log = "";
		try { log = readFileSync(attempt.logFile, "utf8"); } catch {}
		if (log.split('"type":"agent_settled"').length >= 3) break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const command: CommandResult = { id: "late", action: "send", message: "another task", session: "root", createdAt: Date.now(), status: "pending" };
	expect(() => controller.send(command)).toThrow("no longer accepting messages");
	await done;
	expect(attempt.output).toBe("391");
});

test("root stop records stopped after process exit", async () => {
	const { attempt, controller, done } = worker("hang");
	await new Promise((resolve) => setTimeout(resolve, 100));
	controller.stop();
	await done;
	expect(attempt.status).toBe("stopped");
	expect(() => process.kill(attempt.pid!, 0)).toThrow();
});
