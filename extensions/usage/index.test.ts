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
