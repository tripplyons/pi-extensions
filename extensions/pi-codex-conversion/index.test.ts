import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { normalizeCodexConversionConfig } from "@howaboua/pi-codex-conversion/src/adapter/activation/config.ts";
import { registerCodexVoiceShortcuts } from "@howaboua/pi-codex-conversion/src/voice/shortcuts.ts";
import { closeMixtureCodexSessions, preserveNativeFollowUpShortcut } from "./index.ts";

type Shortcut = {
	key: string;
	handler: (ctx: any) => Promise<void>;
};

test("Mixture session cleanup closes only validated nested role sessions", () => {
	const closed: string[] = [];
	closeMixtureCodexSessions({ sessionIds: ["root/mixture/run/lead", "root/mixture/run/writer"] }, id => closed.push(id));
	closeMixtureCodexSessions({ sessionIds: ["", 3] }, id => closed.push(id));
	expect(closed).toEqual(["root/mixture/run/lead", "root/mixture/run/writer"]);
});

test("Codex wrapper reserves Alt+Enter for native Pi follow-up", () => {
	const registered: string[] = [];
	const pi = {
		registerShortcut(key: string) {
			registered.push(key);
		},
	};
	const wrapped = preserveNativeFollowUpShortcut(pi as any);
	wrapped.registerShortcut("alt+enter", { description: "Codex voice", handler() {} });
	wrapped.registerShortcut("ctrl+alt+d", { description: "Codex dictation", handler() {} });
	expect(registered).toEqual(["ctrl+alt+d"]);
});

test("Codex voice registration leaves Alt+Enter to native Pi follow-up", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configPath = join(agentDir, "pi-codex-conversion.json");
	const config = normalizeCodexConversionConfig(
		existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : undefined,
	);
	const shortcuts: Shortcut[] = [];
	const events = new Map<string, (...args: any[]) => void>();
	let terminalInput: ((data: string) => unknown) | undefined;
	const actions: string[] = [];
	const ctx = {
		ui: {
			onTerminalInput(handler: (data: string) => unknown) {
				terminalInput = handler;
				return () => { terminalInput = undefined; };
			},
			notify() {},
		},
	};
	const pi = {
		registerShortcut(key: string, options: Shortcut) {
			shortcuts.push({ key, handler: options.handler });
		},
		on(event: string, handler: (...args: any[]) => void) {
			events.set(event, handler);
		},
	};

	registerCodexVoiceShortcuts(pi as any, config, () => config, {
		startDictation: async () => { actions.push("start-dictation"); },
		finishDictation: async () => { actions.push("finish-dictation"); },
		toggleDictation: async () => { actions.push("toggle-dictation"); },
		toggleRealtime: async () => { actions.push("toggle-realtime"); },
		toggleInputMute: () => { actions.push("toggle-mute"); },
		toggleServer: async () => { actions.push("toggle-server"); },
	});

	expect(config.voice).toMatchObject({
		dictationShortcut: "ctrl+alt+d",
		realtimeShortcut: "ctrl+alt+space",
		muteShortcut: "ctrl+alt+m",
		serverShortcut: "ctrl+alt+g",
	});
	expect(shortcuts.map(({ key }) => key)).toEqual([
		config.voice.dictationShortcut,
		config.voice.realtimeShortcut,
		config.voice.muteShortcut,
		config.voice.serverShortcut,
	]);
	expect(shortcuts.some(({ key }) => key === "alt+enter")).toBe(false);

	await events.get("session_start")?.({}, ctx);
	const encodedAltEnter = "\u001b\r";
	expect(terminalInput?.(encodedAltEnter)).toBeUndefined();
	expect(actions).toEqual([]);

	const realtime = shortcuts.find(({ key }) => key === config.voice.realtimeShortcut);
	expect(realtime).toBeDefined();
	await realtime!.handler(ctx);
	expect(actions).toEqual(["toggle-realtime"]);

	const nativeConfigDir = mkdtempSync(join(tmpdir(), "pi-alt-enter-"));
	try {
		writeFileSync(join(nativeConfigDir, "keybindings.json"), "{}\n");
		const keybindings = KeybindingsManager.create(nativeConfigDir);
		expect(keybindings.getKeys("app.message.followUp")).toContain("alt+enter");
		let followUpAction = 0;
		const editor = new CustomEditor(
			{ requestRender() {} } as any,
			{ borderColor: () => "" } as any,
			keybindings,
		);
		editor.onAction("app.message.followUp", () => { followUpAction++; });
		editor.handleInput(encodedAltEnter);
		expect(followUpAction).toBe(1);
	} finally {
		rmSync(nativeConfigDir, { recursive: true, force: true });
	}
});
