import { expect, mock, spyOn, test } from 'bun:test';
import { harness } from '../../lib/harness.ts';
import install, { parseUsage, formatUsage, fetchUsage } from './index.ts';
const payload = { rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 25, reset_after_seconds: 120 } }, additional_rate_limits: [{ rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: 110, reset_at: 200 } } }] };
test('usage windows, clamping, relative resets and Prime fallback', () => {
  expect(parseUsage(payload, 100)).toEqual({ fiveHour: { remaining: 75, reset: 220 }, weekly: { remaining: 0, reset: 200 } });
  expect(parseUsage({ rate_limit: { primary_window: { used_percent: -1 } } }).weekly?.remaining).toBe(100);
  expect(formatUsage(parseUsage(payload, 100), 100)).toBe('Codex usage\n1w  0% remaining · resets in 0d 0h 2m');
  expect(() => parseUsage({})).toThrow('no supported');
});
test('five-hour quota is not displayed or used as a weekly fallback', () => {
  const usage = parseUsage({ rate_limit: payload.rate_limit }, 100);
  expect(usage.fiveHour?.remaining).toBe(75);
  expect(usage.weekly).toBeUndefined();
  expect(formatUsage(usage, 100)).toBe('Codex usage\n1w  unavailable');
  expect(formatUsage({ weekly: { remaining: 60 } }, 100)).toBe('Codex usage\n1w  60% remaining · reset time unavailable');
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

test('new OpenAI login shows ChatGPT usage without resolving or sending credentials', async () => {
  const h = harness(); install(h.pi);
  h.ctx.model = { provider: 'openai' };
  const getProviderAuth = mock(async () => { throw new Error('Must not resolve another account'); });
  h.ctx.modelRegistry = { getProviderAuth };
  const notify = spyOn(h.ctx.ui, 'notify');
  const request = spyOn(globalThis, 'fetch');
  try {
    await h.command('codex-usage');
    expect(notify).toHaveBeenCalledWith('ChatGPT usage\nIn-terminal quota is unavailable for Sign in with ChatGPT.\nManage usage: https://chatgpt.com/settings/usage', 'info');
    expect(getProviderAuth).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); notify.mockRestore(); }
});

test('legacy Codex login still resolves credentials and displays weekly quota', async () => {
  const h = harness(); install(h.pi);
  h.ctx.model = { provider: 'openai-codex' };
  const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.signature`;
  const getProviderAuth = mock(async () => ({ auth: { apiKey: token } }));
  h.ctx.modelRegistry = { getProviderAuth };
  const notify = spyOn(h.ctx.ui, 'notify');
  const request = spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(options?.headers).get('ChatGPT-Account-Id')).toBe('synthetic-account');
    return Response.json(payload);
  });
  try {
    await h.command('codex-usage');
    expect(getProviderAuth).toHaveBeenCalledWith('openai-codex');
    expect(request).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Codex usage\n1w  0% remaining · resets now', 'info');
  } finally { request.mockRestore(); notify.mockRestore(); }
});

test('new login cancels a pending legacy quota lookup without showing stale results', async () => {
  const h = harness(); install(h.pi);
  h.ctx.model = { provider: 'openai-codex' };
  let resolveAuth!: (value: undefined) => void;
  const auth = new Promise<undefined>(resolve => { resolveAuth = resolve; });
  h.ctx.modelRegistry = { getProviderAuth: () => auth };
  const notify = spyOn(h.ctx.ui, 'notify');
  const legacy = h.command('codex-usage');
  try {
    h.ctx.model = { provider: 'openai' };
    await h.command('codex-usage');
  } finally { resolveAuth(undefined); await legacy; }
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toContain('https://chatgpt.com/settings/usage');
  notify.mockRestore();
});

test('usage command rejects arguments and unrelated providers', async () => {
  const h = harness(); install(h.pi);
  h.ctx.model = { provider: 'openai' };
  await expect(h.command('codex-usage', 'extra')).rejects.toThrow('Usage: /codex-usage');
  for (const model of [undefined, { provider: 'anthropic' }]) {
    h.ctx.model = model;
    await expect(h.command('codex-usage')).rejects.toThrow('Select an OpenAI or OpenAI Codex model first');
  }
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
