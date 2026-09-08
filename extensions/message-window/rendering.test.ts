import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createWriteToolDefinition, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { createApplyPatchTool } from "@howaboua/pi-codex-conversion/dist/tools/apply-patch/tool.js";
import { installMessageWindow, type InteractiveModePrototype, type TranscriptItem } from "./logic.ts";

initTheme("dark", false);

test("patch and write previews survive history rebuilds", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-preview-"));
	const prototype: InteractiveModePrototype = {
		renderSessionItems: (InteractiveMode.prototype as unknown as InteractiveModePrototype).renderSessionItems,
		async handleEvent() {},
	};
	const restore = installMessageWindow(prototype, 50);
	try {
		const tools = [
			{
				tool: createApplyPatchTool({ showDiffWhenCollapsed: true }),
				args: { input: "*** Begin Patch\n*** Add File: patched.txt\n+patch preview sentinel\n*** End Patch" },
				path: "patched.txt",
				content: "patch preview sentinel",
			},
			{
				tool: createApplyPatchTool({ showDiffWhenCollapsed: true }),
				args: { input: "*** Begin Patch\n*** Update File: patched.txt\n@@\n-patch preview sentinel\n+updated preview sentinel\n*** End Patch" },
				path: "patched.txt",
				content: "updated preview sentinel",
			},
			{
				tool: createWriteToolDefinition(cwd),
				args: { path: "written.txt", content: "write preview sentinel\n" },
				path: "written.txt",
				content: "write preview sentinel",
			},
		];
		for (const { tool, args, path, content } of tools) {
			const result = await tool.execute(tool.name, args as never, undefined, undefined, { cwd } as never);
			expect((await readFile(join(cwd, path), "utf8")).trim()).toBe(content);
			const entries: TranscriptItem[] = [
				{ role: "assistant", content: [{ type: "toolCall", id: tool.name, name: tool.name, arguments: args }], stopReason: "toolUse" },
				{ role: "toolResult", toolCallId: tool.name, ...result, isError: false },
			];
			const mode = {
				chatContainer: new Container(),
				pendingTools: new Map(),
				editor: {},
				settingsManager: {
					getShowCacheMissNotices: () => false,
					getShowImages: () => false,
					getImageWidthCells: () => 60,
				},
				sessionManager: { buildContextEntries: () => entries, getCwd: () => cwd },
				ui: { requestRender() {} },
				getRegisteredToolDefinition: () => tool,
				getUserMessageText: () => "",
				addMessageToChat() {},
				maybeShowAssistantDiagnostics() {},
				renderSessionEntries(items: unknown[]) {
					prototype.renderSessionItems.call(this, items as TranscriptItem[]);
				},
			};
			for (let rebuild = 0; rebuild < 2; rebuild++) {
				await prototype.handleEvent.call(mode, { type: "message_start", message: { role: "assistant" } });
				const output = stripVTControlCharacters(mode.chatContainer.render(100).join("\n"));
				expect(output).toContain(path);
				expect(output).toContain(content);
				expect(output).not.toContain("Patching");
			}
		}
	} finally {
		restore();
		await rm(cwd, { recursive: true, force: true });
	}
});
