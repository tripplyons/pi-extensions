import { expect, test } from "bun:test";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { compactToolRenderers, MAX_STREAM_ARGUMENT_CHARS, registerCompactToolRenderers } from "./tool-renderers.ts";
import { harness } from "../../lib/harness.ts";

function tool(name: string) {
  initTheme();
  return new ToolExecutionComponent(name, "stream", {}, {}, compactToolRenderers(name), { requestRender() {} } as any);
}
function lines(component: ToolExecutionComponent, width = 100) {
  return component.render(width).map(line => stripTerminalSequences(line).trimEnd());
}

test.each(["codemode", "bash", "write", "edit", "swarm_send", "mcp_future"])("%s displays growing arguments before execution starts", name => {
  const component = tool(name);
  expect(lines(component).join("\n")).toContain("writing 0 chars");
  const key = name === "codemode" ? "code" : name === "bash" ? "command" : "content";
  let value = "unchanged prefix ".repeat(100);
  const frames: string[] = [];
  for (const chunk of ["first chunk", "\nsecond chunk", "\nlatest chunk 界"]) {
    value += chunk;
    // Use Pi's partial-JSON parser while the tool's final string and object are still open.
    const args = parseStreamingJson(`{${JSON.stringify(key)}:${JSON.stringify(value).slice(0, -1)}`);
    component.updateArgs(args);
    const frame = lines(component).join("\n");
    expect(frame).toContain(chunk.trim());
    expect(frame).toContain(`writing ${value.length} chars`);
    frames.push(frame);
  }
  expect(new Set(frames).size).toBe(3);
  component.setArgsComplete();
  expect(lines(component).join("\n")).not.toContain("writing");
  expect(lines(component).join("\n")).toContain("pending");
  component.markExecutionStarted();
  expect(lines(component).join("\n")).toContain("running");
  component.updateResult({ content: [{ type: "text", text: "Done." }], isError: false });
  expect(lines(component).join("\n")).toContain("Done.");
});

test("argument previews follow nested values and stay bounded at narrow widths", () => {
  const component = tool("swarm_reload");
  component.updateArgs({ action: "release", assignments: [{ nodeId: "worker", task: "x".repeat(10_000) + "\nNEWEST界" }] });
  expect(lines(component).join("\n")).toContain("NEWEST界");
  for (const width of [0, 1, 8, 20, 40, 100]) {
    const rendered = lines(component, width);
    expect(rendered).toHaveLength(2);
    for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("partial results show the latest output, then restore the final summary", () => {
  const component = tool("bash");
  component.updateArgs({ command: "build" });
  component.setArgsComplete();
  component.markExecutionStarted();
  for (const progress of ["compiling", "linking", "testing"]) {
    component.updateResult({ content: [{ type: "text", text: `Build started\n${progress}` }], isError: false }, true);
    expect(lines(component).join("\n")).toContain(progress);
  }
  component.updateResult({ content: [{ type: "text", text: "Build passed\nFull logs" }], isError: false });
  expect(lines(component).join("\n")).toContain("Build passed");
  expect(lines(component).join("\n")).not.toContain("Full logs");
});

test("codemode streams nested-call progress even when partial content is empty", () => {
  const component = tool("codemode");
  component.setArgsComplete();
  component.markExecutionStarted();
  const update = (calls: unknown[]) => component.updateResult({ content: [], details: { calls }, isError: false }, true);
  update([{ name: "read", status: "running" }]);
  expect(lines(component).join("\n")).toContain("running read (0/1 done)");
  update([{ name: "read", status: "ok" }, { name: "bash", status: "running" }]);
  expect(lines(component).join("\n")).toContain("running bash (1/2 done)");
  update([{ name: "read", status: "ok" }, { name: "bash", status: "error" }]);
  expect(lines(component).join("\n")).toContain("error bash (2/2 done)");
  update([null, {}, { name: "invalid", status: "invented" }]);
  expect(lines(component).join("\n")).toContain("running");
  component.updateResult({ content: [{ type: "text", text: "Script failed\nDetails" }], isError: true });
  expect(lines(component).join("\n")).toContain("error: Script failed");
});

test("expanded calls retain their native streaming renderer", () => {
  initTheme();
  const native = { renderCall(args: any) { return new Text(`native\n${args.code ?? ""}`, 0, 0); } };
  const component = new ToolExecutionComponent("codemode", "expanded", {}, {}, compactToolRenderers("codemode", native), { requestRender() {} } as any);
  component.setExpanded(true);
  component.updateArgs({ code: "first\nsecond" });
  expect(lines(component)).toEqual(["", "native", "first", "second"]);
  component.updateArgs({ code: "first\nsecond\nthird" });
  expect(lines(component)).toEqual(["", "native", "first", "second", "third"]);
  component.setExpanded(false);
  expect(lines(component).join("\n")).toContain("third");
});

test("aborted argument generation displays the error, not a stale writing state", () => {
  const component = tool("codemode");
  component.updateArgs({ code: "incomplete" });
  component.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
  const frame = lines(component).join("\n");
  expect(frame).not.toContain("writing");
  expect(frame).toContain("error: Operation aborted");
});

test("raw argument deltas render even when the provider leaves parsed arguments empty", async () => {
  initTheme();
  const h = harness();
  registerCompactToolRenderers(h.pi);
  const renderer = h.toolRenderers[0]("codemode", () => undefined);
  const block = { type: "toolCall", id: "raw", name: "codemode", arguments: {} };
  const message = { role: "assistant", content: [block] };
  const component = new ToolExecutionComponent("codemode", "raw", block.arguments, {}, renderer, { requestRender() {} } as any);
  const delta = async (text: string) => {
    await h.emit("message_update", { message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: text, partial: message } });
    component.updateArgs(block.arguments);
  };
  await delta('{"code":"first');
  expect(lines(component).join("\n")).toContain("first");
  expect(lines(component).join("\n")).toContain("writing 5 chars");
  await delta('\\nsecond');
  expect(lines(component).join("\n")).toContain("second");
  expect(lines(component).join("\n")).toContain("writing 12 chars");
  expect(block.arguments).toEqual({});
  const snapshot = JSON.stringify(message);
  component.setExpanded(true);
  expect(lines(component).join("\n")).toContain("second");
  expect(JSON.stringify(message)).toBe(snapshot);
  // Native parsed arguments take precedence, including freeform scripts that look like JSON.
  component.setExpanded(false);
  component.updateArgs({ code: "native parsed value" });
  expect(lines(component).join("\n")).toContain("native parsed value");
  await h.emit("message_end", { message });
  component.updateArgs({});
  expect(lines(component).join("\n")).not.toContain("second");
});

test("raw argument recovery is bounded, isolated by call, and cleared on reset", async () => {
  initTheme();
  const h = harness();
  registerCompactToolRenderers(h.pi);
  const renderer = h.toolRenderers[0]("codemode", () => undefined);
  const component = (id: string) => new ToolExecutionComponent("codemode", id, {}, {}, renderer, { requestRender() {} } as any);
  const delta = async (id: string, text: string) => {
    const message = { role: "assistant", content: [{ type: "toolCall", id, name: "codemode", arguments: {} }] };
    await h.emit("message_update", { message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: text, partial: message } });
  };
  await delta("a", '{"code":"alpha');
  await delta("b", '{"code":"beta');
  expect(lines(component("a")).join("\n")).toContain("alpha");
  expect(lines(component("a")).join("\n")).not.toContain("beta");
  expect(lines(component("b")).join("\n")).toContain("beta");
  await delta("a", "x".repeat(MAX_STREAM_ARGUMENT_CHARS));
  await delta("a", "ignored after limit");
  expect(lines(component("a")).join("\n")).not.toContain("ignored after limit");
  for (const event of ["agent_end", "session_start", "session_shutdown"]) {
    await h.emit(event);
    expect(lines(component("b")).join("\n")).not.toContain("beta");
    await delta("b", '{"code":"beta');
    expect(lines(component("b")).join("\n")).toContain("beta");
  }
});

test("streaming previews remove terminal controls", () => {
  const component = tool("codemode");
  component.updateArgs({ code: "\x1b[2J\x1b]52;c;secret\x07latest\r\n\ttext\x00" });
  const frame = lines(component).join("\n");
  expect(frame).toContain("latest text");
  expect(frame).not.toContain("secret");
  expect(frame).not.toContain("\x00");
});
