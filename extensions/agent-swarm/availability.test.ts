import { expect, test } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SWARM_TOOL_NAMES } from "./index.ts";

test("real Pi keeps swarm tools inactive in a fresh session", async () => {
	const cwd = process.cwd();
	const agentDir = mkdtempSync(join(tmpdir(), "pi-swarm-sdk-availability-"));
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))] });
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(cwd) });
	try {
		await session.bindExtensions({ mode: "rpc", onError: error => { throw error; } });
		expect(session.getActiveToolNames().filter(name => name.startsWith("swarm_"))).toEqual([]);
		expect(session.getAllTools().map(tool => tool.name).filter(name => name.startsWith("swarm_"))).toEqual([...SWARM_TOOL_NAMES]);
	} finally {
		session.dispose();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
