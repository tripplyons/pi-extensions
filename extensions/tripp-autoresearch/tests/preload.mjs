import { homedir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

const optional = Symbol("optional");

mock.module("typebox", () => ({
  Type: {
    Array: (items, options = {}) => ({ type: "array", items, ...options }),
    Boolean: (options = {}) => ({ type: "boolean", ...options }),
    Number: (options = {}) => ({ type: "number", ...options }),
    Object: (properties, options = {}) => ({
      type: "object",
      properties,
      required: Object.entries(properties)
        .filter(([, value]) => !value[optional])
        .map(([name]) => name),
      ...options,
    }),
    Optional: (value) => Object.assign(value, { [optional]: true }),
    String: (options = {}) => ({ type: "string", ...options }),
    Unknown: () => ({}),
  },
}));

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values) => ({ type: "string", enum: [...values] }),
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
  DEFAULT_MAX_BYTES: 50_000,
  DEFAULT_MAX_LINES: 2_000,
  formatSize: (bytes) => `${bytes}B`,
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  truncateTail: (content) => {
    const lines = content.split("\n");
    const bytes = Buffer.byteLength(content, "utf8");
    return {
      content,
      truncated: false,
      outputBytes: bytes,
      outputLines: lines.length,
      totalBytes: bytes,
      totalLines: lines.length,
    };
  },
}));

mock.module("@earendil-works/pi-tui", () => ({
  matchesKey: (input, key) => input === key,
  Text: class {
    constructor(text) {
      this.text = text;
    }
    invalidate() {}
    render() {
      return this.text.split("\n");
    }
    setText(text) {
      this.text = text;
    }
  },
  truncateToWidth: (text, width) => text.slice(0, width),
  visibleWidth: (text) => text.length,
}));
