import { expect, test } from "bun:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { installHiddenThinkingBlocks } from "./thinking-blocks.ts";
import { installCompactToolSpacing } from "./tool-spacing.ts";

function varint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
const scalar = (field: number, value: number) => Buffer.from([...varint(field * 8), ...varint(value)]);
const bytes = (field: number, value: Buffer) => Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(value.length)]), value]);
const envelope = (metadata: Buffer, format = 4, opaque = Buffer.alloc(256, 7)) => Buffer.concat([
  scalar(1, format), bytes(2, Buffer.concat([bytes(1, metadata), bytes(5, opaque)])), scalar(3, 1),
]).toString("base64");
const signature = (kind = "narration", format = 4, opaque?: Buffer) => envelope(Buffer.concat([
  scalar(1, 19), scalar(3, 2), scalar(7, 1), bytes(8, Buffer.from(kind)),
]), format, opaque);
const thinking = (text = "private reasoning", thinkingSignature?: string) => ({ type: "thinking", thinking: text, thinkingSignature });
const narration = (text = "Yes, this is an **improvement**.") => thinking(text, signature());
const prose = (text: string) => ({ type: "text", text });
const toolCall = { type: "toolCall", id: "call", name: "read", arguments: {} };
const message = (content: unknown[], extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra }) as any;
const plain = (view: AssistantMessageComponent) => view.render(60).map(line => stripTerminalSequences(line).trimEnd());

function component(content: unknown[], hidden = true, extra = {}) {
  initTheme();
  return new AssistantMessageComponent(message(content, extra), hidden);
}

test("narration renders as normal assistant Markdown before tools without changing signed messages", () => {
  const block = narration();
  const input = message([Object.freeze(block), toolCall]);
  Object.freeze(input.content);
  Object.freeze(input);
  const snapshot = JSON.stringify(input);
  const view = component([]);
  view.updateContent(input);
  const expected = component([prose(block.thinking), toolCall]).render(60);
  expect(plain(view).join("\n")).toContain("Thinking...");
  const restore = installHiddenThinkingBlocks();
  try {
    expect(view.render(60)).toEqual(expected);
    view.invalidate();
    expect(view.render(60)).toEqual(expected);
    view.setHideThinkingBlock(false);
    expect(view.render(60)).toEqual(expected);
    view.setHideThinkingBlock(true);
    expect(view.render(60)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(snapshot);
  } finally { restore(); }
  expect(plain(view).join("\n")).toContain("Thinking...");
});

test("live updates reveal narration only after its complete marker arrives", () => {
  const restore = installHiddenThinkingBlocks();
  try {
    const block = thinking("Answer between tools");
    const input = message([block]);
    const view = component([]);
    view.updateContent(input, true);
    expect(plain(view)).toEqual([]);
    block.thinkingSignature = signature().slice(0, 12);
    view.updateContent(input, true);
    expect(plain(view)).toEqual([]);
    block.thinkingSignature = signature();
    view.updateContent(input, true);
    expect(plain(view)).toEqual(plain(component([prose(block.thinking)])));
    block.thinking += " with more detail.";
    input.content.push(thinking(), toolCall);
    view.updateContent(input, true);
    expect(plain(view)).toEqual(plain(component([prose(block.thinking), toolCall])));
    view.invalidate();
    expect(plain(view).join("\n")).not.toContain("private reasoning");
    expect(input.content[0]).toBe(block);
    expect(block.type).toBe("thinking");
    expect(block.thinkingSignature).toBe(signature());
  } finally { restore(); }
});

test("narration becomes visible between compact tool calls during a streaming turn", () => {
  const view = component([]);
  const block = thinking("Answer between tools");
  const input = message([thinking(), block, toolCall], { stopReason: "toolUse" });
  const call = (name: string) => new ToolExecutionComponent(name, name, {}, {}, {
    renderShell: "self", renderCall: () => new Text(name, 0, 0),
  } as any, { requestRender() {} } as any);
  const chat = new Container();
  chat.addChild(call("before"));
  chat.addChild(view);
  chat.addChild(call("after"));
  const restoreThinking = installHiddenThinkingBlocks();
  const restoreSpacing = installCompactToolSpacing();
  const rows = () => chat.render(60).map(line => stripTerminalSequences(line).trim());
  try {
    view.updateContent(input, true);
    expect(rows()).toEqual(["", "before", "after"]);
    block.thinkingSignature = signature();
    view.updateContent(input, true);
    expect(rows()).toEqual(["", "before", "", "Answer between tools", "", "after"]);
    chat.invalidate();
    expect(rows()).toEqual(["", "before", "", "Answer between tools", "", "after"]);
  } finally { restoreSpacing(); restoreThinking(); }
});

test("narration splits thinking runs but keeps genuine thinking hidden or natively expanded", () => {
  const content = [prose("Opening"), thinking("first reasoning"), narration("Public reply"), thinking("last reasoning"), prose("Closing")];
  const expanded = component([content[0], content[1], prose("Public reply"), content[3], content[4]], false).render(60);
  const restore = installHiddenThinkingBlocks();
  try {
    const view = component(content);
    expect(plain(view)).toEqual(plain(component([prose("Opening"), prose("Public reply"), prose("Closing")])));
    view.setHideThinkingBlock(false);
    expect(view.render(60)).toEqual(expanded);
    for (const text of ["first reasoning", "last reasoning"]) {
      const rows = plain(view);
      expect(view.handleMouse({ type: "click", button: "left", x: 1, y: rows.findIndex(row => row.includes(text)),
        screenX: 1, screenY: 1, width: 60, height: rows.length,
        shift: false, alt: false, ctrl: false })?.handled).toBe(true);
      expect(plain(view).join("\n")).not.toContain(text);
      expect(plain(view).join("\n")).toContain("Public reply");
    }
    expect(plain(view)).toEqual(plain(component([prose("Opening"), prose("Public reply"), prose("Closing")])));
  } finally { restore(); }
});

test("unknown, malformed, and incomplete signatures remain ordinary thinking", () => {
  const signatures = [
    undefined, "", "narration", Buffer.from("not protobuf").toString("base64"),
    Buffer.from(JSON.stringify({ v: 1, kind: "narration", data: "not the provider format" })).toString("base64"),
    signature("thinking"), signature("Narration"), signature(""), signature("narration", 3), signature("narration", 5),
    signature("thinking", 4, Buffer.from("narration")),
    scalar(1, 4).toString("base64"),
    Buffer.concat([scalar(1, 4), scalar(2, 1)]).toString("base64"),
    Buffer.concat([scalar(1, 4), bytes(2, scalar(1, 1))]).toString("base64"),
    envelope(Buffer.alloc(0)), envelope(scalar(8, 1)),
    envelope(Buffer.concat([bytes(8, Buffer.from("thinking")), bytes(8, Buffer.from("narration"))])),
    envelope(Buffer.from([0])), envelope(Buffer.from([0x46])), envelope(Buffer.from([0x42, 0xff])),
    envelope(Buffer.from([0x42, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])),
    envelope(Buffer.from([0x49, 0])), envelope(Buffer.from([0x4d, 0])),
    signature().slice(0, -8), `!${signature()}`, `${signature()}!`,
    `${signature().replace(/=+$/, "")}===`,
  ];
  const restore = installHiddenThinkingBlocks();
  try {
    for (const marker of signatures) {
      const view = component([thinking("private reasoning", marker)]);
      expect(plain(view)).toEqual([]);
      view.setHideThinkingBlock(false);
      expect(plain(view).join("\n")).toContain("private reasoning");
    }
  } finally { restore(); }
});

test("padded and unpadded binary signature envelopes display narration", () => {
  const restore = installHiddenThinkingBlocks();
  try {
    const padded = signature("narration", 4, Buffer.alloc(257, 7));
    expect(padded.endsWith("=")).toBe(true);
    for (const marker of [padded, padded.replace(/=+$/, "")]) {
      expect(plain(component([thinking("Public reply", marker)])))
        .toEqual(plain(component([prose("Public reply")])));
    }
  } finally { restore(); }
});

test("narration preserves failure notices and native rendering returns when the adapter is removed", () => {
  const view = component([narration()], false);
  const native = view.render(60);
  let live: AssistantMessageComponent;
  const restore = installHiddenThinkingBlocks();
  try {
    live = component([narration()], false);
    expect(live.render(60)).toEqual(component([prose(narration().thinking)], false).render(60));
    expect(view.render(60)).toEqual(component([prose(narration().thinking)], false).render(60));
    for (const stopReason of ["length", "error", "aborted"]) {
      const extra = { stopReason, errorMessage: "failure detail" };
      expect(component([narration()], true, extra).render(60))
        .toEqual(component([prose(narration().thinking)], true, extra).render(60));
    }
  } finally { restore(); }
  expect(view.render(60)).toEqual(native);
  expect(live!.render(60)).toEqual(native);
});
