import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import codemodeTimeout, { capCodemodeTimeout } from "./index";

test("adds a five-minute deadline when none is set", () => {
  expect(capCodemodeTimeout('text("ok");')).toBe('// @options: {"timeout_ms":300000}\ntext("ok");');
  expect(capCodemodeTimeout('// @options: {"max_output_tokens":42}\ntext("ok");'))
    .toBe('// @options: {"max_output_tokens":42,"timeout_ms":300000}\ntext("ok");');
});

test("caps larger deadlines and preserves options and script text", () => {
  expect(capCodemodeTimeout(' \t// @options: {"timeout_ms":900000,"max_output_tokens":42}\r\ntext("ok");'))
    .toBe('// @options: {"timeout_ms":300000,"max_output_tokens":42}\ntext("ok");');
  expect(capCodemodeTimeout('// @options: {"timeout_ms":1e100}\nreturn 1;'))
    .toContain('"timeout_ms":1e100');
});

test.each([1, 60000, 300000])("keeps a timeout of %i ms unchanged", (timeout) => {
  const source = `// @options: {"timeout_ms":${timeout}}\nreturn 1;`;
  expect(capCodemodeTimeout(source)).toBe(source);
});

test.each(["", "  ", '// @options: broken\nreturn 1;', '// @options: []\nreturn 1;',
  '// @options: null\nreturn 1;', '// @options: {"timeout_ms":0}\nreturn 1;',
  '// @options: {"timeout_ms":"900000"}\nreturn 1;'])("leaves invalid input to Pi: %s", (source) => {
  expect(capCodemodeTimeout(source)).toBe(source);
});

test("changes only codemode calls with string source", () => {
  let handler: (event: ToolCallEvent) => unknown;
  codemodeTimeout({ on(name, callback) {
    expect(name).toBe("tool_call");
    handler = callback;
  } } as ExtensionAPI);
  const event = { type: "tool_call", toolCallId: "test", toolName: "codemode", input: { code: "return 1;" } } as ToolCallEvent;
  handler!(event);
  expect(event.input.code).toBe('// @options: {"timeout_ms":300000}\nreturn 1;');
  const other = { ...event, toolName: "other", input: { code: "return 1;" } };
  handler!(other);
  expect(other.input.code).toBe("return 1;");
  handler!({ ...event, input: { code: 42 } });
});
