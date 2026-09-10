import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import complainExtension, { complaintLogPath } from "./index";

const originalStateHome = process.env.XDG_STATE_HOME;
const originalComplaintLog = process.env.PI_COMPLAIN_LOG;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = originalStateHome;
	if (originalComplaintLog === undefined) delete process.env.PI_COMPLAIN_LOG;
	else process.env.PI_COMPLAIN_LOG = originalComplaintLog;
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(sessionFile: string | null = "/sessions/work.jsonl") {
	const state = await mkdtemp(join(tmpdir(), "pi-complain-"));
	temporaryDirectories.push(state);
	process.env.XDG_STATE_HOME = state;
	delete process.env.PI_COMPLAIN_LOG;
	let tool: Parameters<ExtensionAPI["registerTool"]>[0];
	complainExtension({ registerTool: (registered) => { tool = registered; } } as ExtensionAPI);
	const ctx = {
		cwd: "/projects/example",
		model: { provider: "openai-codex", id: "gpt-5.4" },
		thinkingLevel: "high",
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => sessionFile ?? undefined,
		},
	} as unknown as ExtensionContext;
	return {
		state,
		path: complaintLogPath(),
		description: tool.description,
		invoke: (toolCallId: string, message: string) => tool.execute(toolCallId, { message }, new AbortController().signal, undefined, ctx),
	};
}

test("guidance proactively targets repeated material infrastructure failures", async () => {
	const extension = await setup();
	expect(extension.description).toContain("proactively");
	expect(extension.description).toContain("reproducible infrastructure or harness failure");
	expect(extension.description).toContain("repeatedly impedes work");
	expect(extension.description).toContain("do not report ordinary task errors or isolated transient failures");
});

test("appends concurrent complaints with session context", async () => {
	const extension = await setup();
	const [first, second] = await Promise.all([
		extension.invoke("call-1", "Shell tool omitted stderr"),
		extension.invoke("call-2", "Browser tool lost its connection"),
	]);
	const records = (await readFile(extension.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

	expect(records.map((record) => record.message)).toEqual([
		"Shell tool omitted stderr",
		"Browser tool lost its connection",
	]);
	expect(records[0]).toMatchObject({
		schemaVersion: 1,
		toolCallId: "call-1",
		session: { id: "session-123", path: "/sessions/work.jsonl" },
		cwd: "/projects/example",
		model: { provider: "openai-codex", id: "gpt-5.4" },
		thinkingLevel: "high",
	});
	expect(new Date(records[0].timestamp).toISOString()).toBe(records[0].timestamp);
	expect(first.details).toEqual({ path: extension.path, record: records[0] });
	expect(second.details).toEqual({ path: extension.path, record: records[1] });
});

test("records an ephemeral session with a null path", async () => {
	const extension = await setup(null);
	await extension.invoke("call-ephemeral", "Session could not be persisted");
	const record = JSON.parse((await readFile(extension.path, "utf8")).trim());
	expect(record.session).toEqual({ id: "session-123", path: null });
});

test("reports storage failures instead of claiming success", async () => {
	const extension = await setup();
	await rm(extension.state, { recursive: true });
	await writeFile(extension.state, "not a directory");

	await expect(extension.invoke("call-failed", "State directory is unavailable")).rejects.toThrow();
});

test("honors an absolute controller-supplied log path", async () => {
	const extension = await setup();
	process.env.PI_COMPLAIN_LOG = join(extension.state, "shared", "swarm-complaints.jsonl");
	await extension.invoke("call-worker", "Worker could not run the formatter");

	expect(JSON.parse((await readFile(process.env.PI_COMPLAIN_LOG, "utf8")).trim()).message).toBe("Worker could not run the formatter");
	process.env.PI_COMPLAIN_LOG = "relative.jsonl";
	await expect(extension.invoke("call-invalid", "Invalid log configuration")).rejects.toThrow("PI_COMPLAIN_LOG must be an absolute path");
});
