import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeCodexConversionConfig } from "@howaboua/pi-codex-conversion/src/adapter/activation/config.ts";

// Apply the tracked dependency patch in isolation, without modifying the installed runtime.
const root = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(join(tmpdir(), "pi-voice-input-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const relative = "node_modules/@howaboua/pi-codex-conversion/dist/voice/conversation/helper-offer.js";
const target = join(directory, relative);
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(root, relative), target);
const patch = join(root, "patches/@howaboua+pi-codex-conversion+3.0.33.patch");
const args = ["git", "apply", "--unsafe-paths", `--include=${relative}`];
const check = Bun.spawnSync([...args, "--check", patch], { cwd: directory });
if (check.exitCode === 0) {
	const applied = Bun.spawnSync([...args, patch], { cwd: directory });
	if (applied.exitCode !== 0) throw new Error(applied.stderr.toString());
} else {
	const reverse = Bun.spawnSync([...args, "--reverse", "--check", patch], { cwd: directory });
	if (reverse.exitCode !== 0) throw new Error(check.stderr.toString());
}
const { startRealtimeOffer } = await import(pathToFileURL(target).href);

function harness(
	inputs: Array<{ id: string; name: string }>,
	inputDevice: string | undefined = "coreaudio:boya",
	inputDeviceName?: string,
) {
	const events = new Set<(event: any) => void>();
	const exits = new Set<(error: Error) => void>();
	const commands: any[] = [];
	const config = { tools: {}, voice: { inputDeviceName, inputDevice, outputDevice: "coreaudio:speaker" } };
	let failure: Error | undefined;
	const helper = {
		protocolVersion: 5,
		async start() {},
		async close() {},
		onEvent(listener: (event: any) => void) { events.add(listener); return () => events.delete(listener); },
		onExit(listener: (error: Error) => void) { exits.add(listener); return () => exits.delete(listener); },
		send(command: any) {
			commands.push(command);
			queueMicrotask(() => {
				const event = failure ? { type: "error", message: failure.message }
					: command.type === "list_devices" ? { type: "devices", inputs, outputs: [] }
					: { type: "offer", sdp: "test-offer" };
				for (const listener of events) listener(event);
			});
		},
	};
	return { commands, config, events, exits, helper, fail: (error: Error) => { failure = error; } };
}

const other = { id: "coreaudio:other", name: "Other input" };
const boya = { id: "coreaudio:boya", name: "BOYA mini 2" };

test("realtime keeps the preferred microphone when present", async () => {
	const h = harness([other, boya]);
	expect(await startRealtimeOffer(h.helper, h.config, "native")).toBe("test-offer");
	expect(h.commands).toEqual([
		{ type: "list_devices" },
		{ type: "start_v3", microphone: boya.id, speaker: "coreaudio:speaker" },
	]);
	expect(h.events.size + h.exits.size).toBe(0);
});

test("missing BOYA follows the system default, not the first input, without changing the preference", async () => {
	for (const inputs of [[other], []]) {
		const h = harness(inputs);
		await startRealtimeOffer(h.helper, h.config, "native");
		expect(h.commands).toEqual([
			{ type: "list_devices" },
			{ type: "start_v3", speaker: "coreaudio:speaker" },
		]);
		expect(h.config.voice.inputDevice).toBe(boya.id);
	}
});

test("preferred microphone name resolves its current device ID on every start", async () => {
	const renamed = { id: "coreaudio:boya-current", name: boya.name };
	const h = harness([other, renamed], "coreaudio:boya-stale", boya.name);
	await startRealtimeOffer(h.helper, h.config, "native");
	expect(h.commands).toEqual([
		{ type: "list_devices" },
		{ type: "start_v3", microphone: renamed.id, speaker: "coreaudio:speaker" },
	]);
});

test("missing preferred microphone name follows the system default even when its saved ID is connected", async () => {
	const h = harness([other], other.id, boya.name);
	await startRealtimeOffer(h.helper, h.config, "native");
	expect(h.commands.at(-1)).toEqual({ type: "start_v3", speaker: "coreaudio:speaker" });
});

test("normalization preserves the preferred microphone name", () => {
	const config = normalizeCodexConversionConfig({ voice: { inputDeviceName: boya.name } });
	expect(config.voice.inputDeviceName).toBe(boya.name);
});

test("unconfigured input and bridge mode retain their existing commands", async () => {
	const h = harness([boya]);
	h.config.voice.inputDevice = undefined;
	await startRealtimeOffer(h.helper, h.config, "native");
	expect(h.commands).toEqual([{ type: "start_v3", speaker: "coreaudio:speaker" }]);
	const bridge = harness([boya]);
	await startRealtimeOffer(bridge.helper, bridge.config, "bridge");
	expect(bridge.commands).toEqual([{ type: "start_v3_bridge" }]);
});

test("a later start uses BOYA again after it reconnects", async () => {
	const inputs = [other];
	const h = harness(inputs);
	await startRealtimeOffer(h.helper, h.config, "native");
	inputs.push(boya);
	await startRealtimeOffer(h.helper, h.config, "native");
	expect(h.commands.at(-1)).toEqual({ type: "start_v3", microphone: boya.id, speaker: "coreaudio:speaker" });
});

test("capture errors after enumeration are not retried on a different microphone", async () => {
	const h = harness([boya]);
	const send = h.helper.send;
	h.helper.send = (command) => {
		if (command.type === "start_v3") h.fail(new Error("Microphone permission denied"));
		send(command);
	};
	await expect(startRealtimeOffer(h.helper, h.config, "native")).rejects.toThrow("Microphone permission denied");
	expect(h.commands).toHaveLength(2);
	expect(h.events.size + h.exits.size).toBe(0);
});

test("enumeration errors remain errors and remove listeners", async () => {
	const h = harness([boya]);
	h.fail(new Error("Cannot enumerate audio inputs"));
	await expect(startRealtimeOffer(h.helper, h.config, "native")).rejects.toThrow("Cannot enumerate audio inputs");
	expect(h.commands).toEqual([{ type: "list_devices" }]);
	expect(h.events.size + h.exits.size).toBe(0);
});
