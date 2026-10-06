import { expect, test } from "bun:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { compactToolRenderers } from "./tool-renderers.ts";
import { installCompactToolSpacing } from "./tool-spacing.ts";
import { installHiddenThinkingBlocks } from "./thinking-blocks.ts";
import { installCompactUserMessages } from "./user-messages.ts";

test("tool shells remove the separator and preserve output spacing", () => {
  initTheme();
  const tool = new ToolExecutionComponent("example", "1", {}, {}, undefined, { requestRender() {} } as any);
  tool.updateResult({ content: [{ type: "text", text: "first\n\nlast" }], isError: false }, false);
  const plain = () => tool.render(60).map(line => stripTerminalSequences(line).trim());
  const before = plain();
  const restore = installCompactToolSpacing();
  try {
    expect(plain()).toEqual(["example", "", "{}", "first", "", "last"]);
    tool.setExpanded(true);
    expect(plain()).toEqual(["example", "", "{}", "first", "", "last"]);
  } finally { restore(); }
  expect(plain()).toEqual(before);
});

test("renderer-backed tools lose only the outer separator in either shell", () => {
  initTheme();
  const definition = { renderCall: () => new Text("call", 0, 0), renderResult: () => new Text("result", 0, 0) };
  const tool = new ToolExecutionComponent("example", "2", {}, {}, definition as any, { requestRender() {} } as any);
  const self = new ToolExecutionComponent("example", "3", {}, {}, { ...definition, renderShell: "self" } as any, { requestRender() {} } as any);
  const before = tool.render(60);
  const selfBefore = self.render(60);
  const restore = installCompactToolSpacing();
  try {
    expect(tool.render(60).map(line => stripTerminalSequences(line).trim())).toEqual(["call"]);
    expect(self.render(60)).toEqual(selfBefore.slice(1));
  } finally { restore(); }
  expect(tool.render(60)).toEqual(before);
  expect(self.render(60)).toEqual(selfBefore);
});

test("adjacent compact calls stay on consecutive rows across updates and resize", () => {
  initTheme();
  const calls = ["read", "bash", "mcp_future"].map((name, i) =>
    new ToolExecutionComponent(name, String(i), { path: "file.ts", command: "echo done" }, {}, compactToolRenderers(name) as any, { requestRender() {} } as any));
  const chat = new Container();
  for (const call of calls) chat.addChild(call);
  const restore = installCompactToolSpacing();
  try {
    const check = () => {
      for (const width of [8, 60, 100]) {
        const rows = chat.render(width).map(stripTerminalSequences);
        expect(rows).toHaveLength(calls.length + 1);
        expect(rows[0]).toBe("");
        expect(rows.slice(1).every(row => row.trim().length > 0)).toBe(true);
      }
    };
    check();
    for (const call of calls) {
      call.updateArgs({ path: "updated.ts", command: "echo updated" });
      call.setArgsComplete();
      call.markExecutionStarted();
      check();
      call.updateResult({ content: [{ type: "text", text: "partial\noutput" }], isError: false }, true);
      check();
      call.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
      check();
      call.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
      check();
      call.setExpanded(true);
      call.setExpanded(false);
      check();
    }
  } finally { restore(); }
  expect(chat.render(60)).toHaveLength(calls.length * 2);
});

test("self-rendered content keeps intentional blank rows and empty calls stay empty", () => {
  initTheme();
  const tool = new ToolExecutionComponent("example", "blank", {}, {}, {
    renderShell: "self", renderCall: () => new Text("\ncall\n\nlast\n", 0, 0),
  } as any, { requestRender() {} } as any);
  const empty = new ToolExecutionComponent("example", "empty", {}, {}, {
    renderShell: "self", renderCall: () => ({ render: () => [], invalidate() {} }),
  } as any, { requestRender() {} } as any);
  const before = tool.render(60);
  const restore = installCompactToolSpacing();
  try {
    expect(tool.render(60)).toEqual(before.slice(1));
    expect(empty.render(60)).toEqual([]);
  } finally { restore(); }
});

test("clicking the first compact row still expands tools in either shell", () => {
  initTheme();
  const originalMouse = ToolExecutionComponent.prototype.handleMouse;
  const restore = installCompactToolSpacing();
  try {
    for (const renderShell of ["default", "self"]) {
      const tool = new ToolExecutionComponent("example", renderShell, {}, {}, {
        renderShell, renderCall: () => new Text("call", 0, 0),
        renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(options.expanded ? "first\n\nlast" : "summary", 0, 0),
      } as any, { requestRender() {} } as any);
      tool.updateResult({ content: [{ type: "text", text: "output" }], isError: false }, false);
      const click = () => tool.handleMouse({ type: "click", button: "left", x: 1, y: 0,
        screenX: 1, screenY: 0, width: 60, height: tool.render(60).length,
        shift: false, alt: false, ctrl: false });
      expect(click()?.handled).toBe(true);
      expect(tool.render(60).map(line => stripTerminalSequences(line).trim())).toEqual(["call", "first", "", "last"]);
      expect(click()?.handled).toBe(true);
      expect(tool.render(60).map(line => stripTerminalSequences(line).trim())).toEqual(["call", "summary"]);
    }
  } finally { restore(); }
  expect(ToolExecutionComponent.prototype.handleMouse).toBe(originalMouse);
});

test("visible messages start new tool groups while hidden thinking and empty messages do not", () => {
  initTheme();
  const chat = new Container();
  const hidden = new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }], stopReason: "stop" } as any, true);
  const call = (name: string) => new ToolExecutionComponent(name, name, {}, {}, {
    renderShell: "self", renderCall: () => new Text(name, 0, 0),
  } as any, { requestRender() {} } as any);
  chat.addChild(new UserMessageComponent("question"));
  chat.addChild(call("call1"));
  chat.addChild(call("call2"));
  chat.addChild(hidden);
  chat.addChild(new Container());
  chat.addChild(call("call3"));
  chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "explanation" }], stopReason: "stop" } as any));
  chat.addChild(call("call4"));
  chat.addChild(call("call5"));
  const originalContainer = Container.prototype.render;
  const restoreThinking = installHiddenThinkingBlocks();
  const restoreUser = installCompactUserMessages();
  const restore = installCompactToolSpacing();
  const rows = () => chat.render(60).map(line => stripTerminalSequences(line).trim());
  try {
    expect(rows()).toEqual(["question", "", "call1", "call2", "call3", "", "explanation", "", "call4", "call5"]);
    hidden.setHideThinkingBlock(false);
    expect(rows()).toEqual(["question", "", "call1", "call2", "", "reasoning", "", "call3", "", "explanation", "", "call4", "call5"]);
    hidden.setHideThinkingBlock(true);
    expect(rows()).toEqual(["question", "", "call1", "call2", "call3", "", "explanation", "", "call4", "call5"]);
  } finally { restore(); restoreThinking(); restoreUser(); }
  expect(Container.prototype.render).toBe(originalContainer);
});

test("group separators keep mouse targets aligned for both first and following calls", () => {
  initTheme();
  const restore = installCompactToolSpacing();
  try {
    for (const renderShell of ["default", "self"]) {
      const chat = new Container();
      chat.addChild(new Text("intro", 0, 0));
      for (const name of ["call1", "call2"]) {
        const tool = new ToolExecutionComponent(name, name, {}, {}, {
          renderShell, renderCall: () => new Text(name, 0, 0),
          renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(options.expanded ? "first\n\nlast" : "summary", 0, 0),
        } as any, { requestRender() {} } as any);
        tool.updateResult({ content: [{ type: "text", text: "output" }], isError: false }, false);
        chat.addChild(tool);
      }
      const rows = () => chat.render(60).map(line => stripTerminalSequences(line).trim());
      expect(rows()).toEqual(["intro", "", "call1", "summary", "call2", "summary"]);
      for (const name of ["call1", "call2"]) {
        const before = rows();
        expect(chat.handleMouse({ type: "click", button: "left", x: 1, y: before.indexOf(name),
          screenX: 1, screenY: 1, width: 60, height: before.length,
          shift: false, alt: false, ctrl: false })?.handled).toBe(true);
      }
      expect(rows()).toEqual(["intro", "", "call1", "first", "", "last", "call2", "first", "", "last"]);
      chat.invalidate();
      expect(rows()).toEqual(["intro", "", "call1", "first", "", "last", "call2", "first", "", "last"]);
    }
  } finally { restore(); }
});
