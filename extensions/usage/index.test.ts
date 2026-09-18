import { expect, test } from 'bun:test';
import { parseUsage, formatUsage, fetchUsage } from './index.ts';
const payload = { rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 25, reset_after_seconds: 120 } }, additional_rate_limits: [{ rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: 110, reset_at: 200 } } }] };
test('usage windows, clamping, relative resets and Prime fallback', () => {
  expect(parseUsage(payload, 100)).toEqual({ fiveHour: { remaining: 75, reset: 220 }, weekly: { remaining: 0, reset: 200 } });
  expect(parseUsage({ rate_limit: { primary_window: { used_percent: -1 } } }).weekly?.remaining).toBe(100);
  expect(formatUsage(parseUsage(payload, 100), 100)).toContain('75% remaining');
  expect(() => parseUsage({})).toThrow('no supported');
});
test('request uses fixed HTTPS endpoint, private headers and blocks redirects', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.signature`;
  const request: any = async (url: string, options: RequestInit) => {
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${token}`);
    return Response.json(payload);
  };
  expect((await fetchUsage(token, new AbortController().signal, request)).fiveHour?.remaining).toBe(75);
  await expect(fetchUsage('invalid', new AbortController().signal, request)).rejects.toThrow('credentials');
  await expect(fetchUsage(token, new AbortController().signal, (async () => new Response('x'.repeat(1048577))) as any)).rejects.toThrow('1 MiB');
});

test("API cost uses only active-branch assistant usage, including failed responses", async () => {
  const { harness } = await import("../../lib/harness.ts");
  const { default: install } = await import("./index.ts");
  const h = harness(); install(h.pi);
  let notice = "";
  h.ctx.ui.notify = (text: string) => { notice = text; };
  h.entries.push({ type: "message", message: { role: "user", content: "hello" } });
  for (const stopReason of ["stop", "error"]) h.entries.push({ type: "message", message: {
    role: "assistant", stopReason,
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.125 } },
  } });
  await h.command("api-cost");
  expect(notice).toContain("2 responses · input 20 · output 4");
  expect(notice).toContain("$0.250000");
  h.entries.length = 0;
  await h.command("api-cost");
  expect(notice).toContain("$0.000000");
  await expect(h.command("api-cost", "reset")).rejects.toThrow("Usage");
});
