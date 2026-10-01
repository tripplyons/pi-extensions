import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";

function setup(result = { stdout: "Provider: openai-codex\nPage [citation]", stderr: "", code: 0, killed: false }) {
  const h = harness();
  const calls: any[] = [];
  h.pi.exec = async (...args: any[]) => { calls.push(args); return result; };
  install(h.pi);
  return { ...h, calls };
}

// Use this test file as an existing path; exec is mocked, so no CLI or login is required.
async function withScript(fn: () => Promise<void>) {
  const previous = process.env.PI_WEB_CLI;
  process.env.PI_WEB_CLI = import.meta.path;
  try { await fn(); } finally {
    if (previous === undefined) delete process.env.PI_WEB_CLI;
    else process.env.PI_WEB_CLI = previous;
  }
}

test("search defaults to Codex, passes literal query and cancellation", () => withScript(async () => {
  const h = setup();
  const signal = new AbortController().signal;
  const output = await h.call("web_search", { query: "--help; $(echo unsafe)" }, signal);
  expect(h.calls[0][0]).toBe("uv");
  expect(h.calls[0][1]).toEqual(["run", "--python", "3.12", import.meta.path, "search", "--provider", "openai-codex", "--timeout", "30", "--max-chars", "8000", "--max-results", "5", "--", "--help; $(echo unsafe)"]);
  expect(h.calls[0][2]).toMatchObject({ signal, timeout: 30000 });
  expect(output.content[0].text).toContain("[citation]");
  for (const name of ["web_search", "web_extract"]) {
    expect(h.tools.has(name)).toBe(true);
  }
}));

test("explicit providers and search options are forwarded", () => withScript(async () => {
  const h = setup();
  await h.call("web_search", { query: "news", provider: "ddgs", timelimit: "w", max_results: 3, timeout: 10, max_chars: 1000 });
  expect(h.calls[0][1]).toEqual(["run", "--python", "3.12", import.meta.path, "search", "--provider", "ddgs", "--timeout", "10", "--max-chars", "1000", "--max-results", "3", "--timelimit", "w", "--", "news"]);
  for (const provider of [undefined, "ddgs", "camoufox"]) {
    await h.call("web_extract", { url: "https://example.com", provider });
    const args = h.calls.at(-1)[1];
    expect(args).toContain(provider ?? "openai-codex");
    expect(args).toContain("20000");
    expect(args.slice(-2)).toEqual(["--", "https://example.com"]);
  }
}));

test("failures, deadlines and empty output fail without fallback", () => withScript(async () => {
  for (const result of [
    { stdout: "", stderr: "login expired", code: 1, killed: false },
    { stdout: "partial", stderr: "", code: 0, killed: true },
    { stdout: " ", stderr: "", code: 0, killed: false },
  ]) {
    const h = setup(result);
    await expect(h.call("web_extract", { url: "https://example.com" })).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  }
}));

test("invalid input, missing CLI and cancellation never execute", () => withScript(async () => {
  const h = setup();
  await expect(h.call("web_search", { query: " " })).rejects.toThrow("blank");
  await expect(h.call("web_extract", { url: "file:///etc/passwd" })).rejects.toThrow("HTTP");
  await expect(h.call("web_search", { query: "test" }, AbortSignal.abort())).rejects.toThrow();
  process.env.PI_WEB_CLI = "/nonexistent/pi-web-cli.py";
  await expect(h.call("web_search", { query: "test" })).rejects.toThrow("Web CLI not found");
  process.env.PI_WEB_CLI = "relative.py";
  await expect(h.call("web_search", { query: "test" })).rejects.toThrow("absolute");
  expect(h.calls).toHaveLength(0);
}));

test("complete output is bounded even if CLI exceeds the requested cap", () => withScript(async () => {
  const h = setup({ stdout: "x".repeat(10000), stderr: "", code: 0, killed: false });
  const output = await h.call("web_search", { query: "test", max_chars: 100 });
  expect(output.content[0].text.length).toBeLessThan(2300);
  expect(output.content[0].text).toContain("Output truncated");
}));

test("web previews show arguments and actual content, including legacy results", () => withScript(async () => {
  const h = setup();
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  for (const name of ["web_search", "web_extract"]) {
    const tool = h.tools.get(name);
    const args = { query: "Pi docs", url: "https://pi.dev", provider: "ddgs", timeout: 10, max_results: 3, max_chars: 1000, timelimit: "w" };
    const call = tool.renderCall(args, theme, {}).render(200).join("\n");
    expect(call).toContain(name === "web_search" ? "Pi docs" : "https://pi.dev");
    expect(call).toContain("ddgs, 10s timeout");
    expect(call).toContain("chars: 1000");
    expect(tool.renderCall({}, theme, {}).render(200).join("\n")).toContain("...");
    const value = { content: [{ type: "text", text: "Page title\nhttps://pi.dev\n[citation]\n" + "body\n".repeat(20) }], details: { provider: "openai-codex" } };
    const collapsed = tool.renderResult(value, { expanded: false }, theme, {}).render(100).join("\n");
    expect(collapsed).toContain("Page title");
    expect(collapsed).toContain("[citation]");
    expect(collapsed).toContain("Expand for more");
    const expanded = tool.renderResult(value, { expanded: true }, theme, {}).render(100).join("\n");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    const error = tool.renderResult({ ...value, content: [{ type: "text", text: "Timed out" }] }, {}, theme, { isError: true }).render(100).join("\n");
    expect(error).toContain("Timed out");
  }
}));

test("progress reports provider and timeout while executing, then stops", () => withScript(async () => {
  const h = setup();
  const updates: any[] = [];
  h.pi.exec = async () => {
    expect(updates[0].content[0].text).toContain("Extracting with openai-codex");
    await new Promise(resolve => setTimeout(resolve, 1100));
    return { stdout: "page", stderr: "", code: 0, killed: false };
  };
  await h.tools.get("web_extract").execute("id", { url: "https://pi.dev" }, undefined, (value: any) => updates.push(value));
  expect(updates.length).toBeGreaterThanOrEqual(2);
  expect(updates.at(-1).content[0].text).toContain("1s elapsed · 30s timeout");
  const count = updates.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(updates).toHaveLength(count);
}));
