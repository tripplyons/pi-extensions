import { expect, test } from "bun:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restore } from "../lib/common.ts";

const assistant = {
  role: "assistant" as const, content: [{ type: "text" as const, text: "fixture reply" }],
  api: "openai-responses" as const, provider: "openai", model: "fixture",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const, timestamp: 1,
};

test("real session files preserve names/model/reasoning and isolate forked extension state", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  try {
    const session = SessionManager.create(root, root);
    session.appendModelChange("openai", "fixture");
    session.appendThinkingLevelChange("high");
    session.appendMessage({ role: "user", content: "fixture question", timestamp: 0 });
    session.appendMessage(assistant);
    session.appendSessionInfo("Original");
    const ancestor = session.appendCustomEntry("rework:fixture", { enabled: false });
    session.appendCustomEntry("rework:fixture", { enabled: true });
    const originalFile = session.getSessionFile()!;
    const reopened = SessionManager.open(originalFile, root);
    expect(reopened.getSessionName()).toBe("Original");
    expect(reopened.buildSessionContext().model).toEqual({ provider: "openai", modelId: "fixture" });
    expect(reopened.buildSessionContext().thinkingLevel).toBe("high");
    const state = (manager: SessionManager) => restore<{ enabled: boolean }>({ sessionManager: manager } as ExtensionContext, "rework:fixture");
    expect(state(reopened)).toEqual({ enabled: true });
    reopened.branch(ancestor);
    expect(state(reopened)).toEqual({ enabled: false });
    const branchFile = reopened.createBranchedSession(ancestor)!;
    const fork = SessionManager.open(branchFile, root);
    expect(fork.getSessionId()).not.toBe(session.getSessionId());
    expect(state(fork)).toEqual({ enabled: false });
    fork.appendCustomEntry("rework:fixture", { enabled: true });
    expect(state(reopened)).toEqual({ enabled: false });
    expect(state(SessionManager.open(originalFile, root))).toEqual({ enabled: true });
    fork.newSession();
    expect(state(fork)).toBeUndefined();
    expect(fork.buildSessionContext().messages).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
