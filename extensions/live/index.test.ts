import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import liveExtension from "./index";

function voiceMessage(state: "started" | "ended", mode = "realtime") {
  return {
    role: "custom",
    customType: "codex-voice-mode",
    content: "",
    details: { mode, state },
  };
}

function setup(entries: any[] = []) {
  const handlers = new Map<string, Function>();
  const sent: Array<{ content: unknown; options: unknown }> = [];
  const notices: string[] = [];
  let command: { description: string; handler: Function };
  const ctx = {
    sessionManager: { getBranch: () => entries },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;

  liveExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, value: typeof command) => {
      expect(name).toBe("live");
      command = value;
    },
    sendUserMessage: (content: unknown, options: unknown) => sent.push({ content, options }),
  } as unknown as ExtensionAPI);

  return {
    notices,
    sent,
    description: () => command.description,
    run: (args = "") => command.handler(args, ctx),
    start: () => handlers.get("session_start")!({}, ctx),
    message: (message: unknown) => handlers.get("message_end")!({ message }, ctx),
  };
}

const dispatchOptions = { expandPromptTemplates: true };

test("alternates start and stop without waiting for lifecycle messages", async () => {
  const session = setup();
  session.start();
  await session.run();
  await session.run();
  expect(session.description()).toBe("Toggle Codex realtime voice");
  expect(session.sent).toEqual([
    { content: "/codex voice realtime", options: dispatchOptions },
    { content: "/codex voice stop", options: dispatchOptions },
  ]);
});

test("stops active realtime voice and starts again after it ends", async () => {
  const session = setup();
  session.start();
  session.message(voiceMessage("started"));
  await session.run();
  session.message(voiceMessage("ended"));
  await session.run();
  expect(session.sent.map(({ content }) => content)).toEqual([
    "/codex voice stop",
    "/codex voice realtime",
  ]);
});

test("restores the latest realtime lifecycle state", async () => {
  const entries = [
    { type: "message", message: voiceMessage("started") },
    { type: "message", message: voiceMessage("ended") },
    { type: "message", message: voiceMessage("started") },
  ];
  const session = setup(entries);
  session.start();
  await session.run();
  expect(session.sent[0]?.content).toBe("/codex voice stop");
});

test("ignores dictation and malformed lifecycle messages", async () => {
  const session = setup([
    { type: "message", message: voiceMessage("started", "dictation") },
    { type: "message", message: { customType: "codex-voice-mode", details: { mode: "realtime", state: "unknown" } } },
  ]);
  session.start();
  await session.run();
  expect(session.sent[0]?.content).toBe("/codex voice realtime");
});

test("rejects arguments", async () => {
  const session = setup();
  await session.run("on");
  expect(session.sent).toHaveLength(0);
  expect(session.notices).toEqual(["Usage: /live"]);
});
