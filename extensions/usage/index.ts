import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Window = { remaining: number; reset?: number };
type Usage = { fiveHour?: Window; weekly?: Window };
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function window(value: unknown, now: number): Window | undefined {
  const item = object(value);
  if (!finite(item.used_percent)) return;
  return { remaining: 100 - Math.max(0, Math.min(100, item.used_percent)),
    reset: finite(item.reset_at) ? item.reset_at : finite(item.reset_after_seconds) ? now + item.reset_after_seconds : undefined };
}
export function parseUsage(payload: unknown, now = Date.now() / 1000): Usage {
  const data = object(payload);
  const main = object(data.rate_limit);
  const limits = [main, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.map((item: unknown) => object(object(item).rate_limit)) : [])];
  const usage: Usage = {};
  for (const limit of limits) for (const name of ["primary_window", "secondary_window"]) {
    const item = object(limit[name]);
    if (item.limit_window_seconds === 18000) usage.fiveHour ??= window(item, now);
    if (item.limit_window_seconds === 604800) usage.weekly ??= window(item, now);
  }
  usage.weekly ??= window(main.primary_window, now) ?? window(main.secondary_window, now);
  if (!usage.fiveHour && !usage.weekly) throw new Error("Codex usage response contains no supported windows");
  return usage;
}
export function formatUsage(usage: Usage, now = Date.now() / 1000) {
  return "Codex usage\n" + ([['5h', usage.fiveHour], ['1w', usage.weekly]] as const).map(([label, item]) => {
    if (!item) return `${label}  unavailable`;
    const minutes = item.reset === undefined ? undefined : Math.max(0, Math.ceil((item.reset - now) / 60));
    const duration = minutes === undefined ? "reset time unavailable" : minutes === 0 ? "resets now" : `resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h ${minutes % 60}m`;
    return `${label}  ${Math.round(item.remaining)}% remaining · ${duration}`;
  }).join("\n");
}
export async function fetchUsage(token: string, signal: AbortSignal, request: typeof fetch = fetch) {
  let account: unknown;
  try { account = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())["https://api.openai.com/auth"]?.chatgpt_account_id; } catch { /* Report a credential error without the token. */ }
  if (!token || /[\r\n]/.test(token) || typeof account !== 'string' || !account || /[\r\n]/.test(account)) throw new Error("Codex OAuth credentials unavailable; use /login");
  const response = await request("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
    redirect: "error", signal,
  });
  if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status})`);
  if (!response.body) throw new Error("Empty Codex usage response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1048576) throw new Error("Codex usage response exceeds 1 MiB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error("Invalid Codex usage response"); }
  return parseUsage(payload);
}
export default function usage(pi: ExtensionAPI) {
  let pending: AbortController | undefined;
  const cancel = () => { pending?.abort(); pending = undefined; };
  for (const event of ["session_switch", "session_shutdown", "model_select", "session_fork", "session_tree"] as const) pi.on(event, cancel);
  pi.registerCommand("codex-usage", {
    description: "Show Codex five-hour and weekly remaining quota",
    async handler(args, ctx) {
      if (args.trim()) throw new Error("Usage: /codex-usage");
      if (ctx.model?.provider !== "openai-codex") throw new Error("Select an OpenAI Codex model first");
      cancel(); const controller = new AbortController(); pending = controller;
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
        if (controller.signal.aborted) return;
        const data = await fetchUsage(auth?.auth.apiKey ?? "", controller.signal);
        if (!controller.signal.aborted) ctx.ui.notify(formatUsage(data), "info");
      } catch {
        if (pending === controller) ctx.ui.notify("Unable to load Codex usage. Check /login and connectivity.", "warning");
      } finally { clearTimeout(timeout); if (pending === controller) pending = undefined; }
    },
  });
}
