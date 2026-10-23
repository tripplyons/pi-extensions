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
  for (const name of ["primary_window", "secondary_window"]) {
    const item = object(main[name]);
    if (item.limit_window_seconds === undefined) usage.weekly ??= window(item, now);
  }
  if (!usage.fiveHour && !usage.weekly) throw new Error("Codex usage response contains no supported windows");
  return usage;
}
function windowLine(label: string, item: Window | undefined, now: number) {
  if (!item) return `${label}  unavailable`;
  const minutes = item.reset === undefined ? undefined : Math.max(0, Math.ceil((item.reset - now) / 60));
  const duration = minutes === undefined ? "reset time unavailable" : minutes === 0 ? "resets now" : `resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h ${minutes % 60}m`;
  return `${label}  ${Math.round(item.remaining)}% remaining · ${duration}`;
}
/** Lists the five-hour window when the account has one; the weekly window always has a line. */
function formatWindows(title: string, usage: Usage, now: number) {
  return [title, ...usage.fiveHour ? [windowLine("5h", usage.fiveHour, now)] : [], windowLine("1w", usage.weekly, now)].join("\n");
}
export function formatUsage(usage: Usage, now = Date.now() / 1000) {
  return formatWindows("Codex usage", usage, now);
}
// The dotfiles bridge patch stores the latest Claude Code rate-limit event here.
const claudeLimitsKey = Symbol.for("claude-bridge:rateLimits");
/** Formats the bridge's latest event; its utilization values are fractions of the window. */
export function formatClaudeUsage(shared: unknown, now = Date.now()) {
  const { info, observedAt } = object(shared);
  if (!finite(observedAt) || !object(info).status) return "Claude usage\nNo Claude response in this Pi process yet; send a Claude request first.\nManage usage: https://claude.ai/settings/usage";
  const windows = object(info.unifiedWindows);
  const claude = (name: string): Window | undefined => {
    const item = object(windows[name]);
    if (finite(item.utilization)) return { remaining: 100 - Math.max(0, Math.min(100, item.utilization * 100)), reset: finite(item.resetsAt) ? item.resetsAt : undefined };
    // Older events report only the window that set their status.
    if (info.rateLimitType === name && finite(info.utilization)) return { remaining: 100 - Math.max(0, Math.min(100, info.utilization * 100)), reset: finite(info.resetsAt) ? info.resetsAt : undefined };
  };
  const minutes = Math.max(0, Math.round((now - observedAt) / 60000));
  const lines = [formatWindows(`Claude usage (as of ${minutes ? `${minutes}m ago` : "now"})`, { fiveHour: claude("five_hour"), weekly: claude("seven_day") }, now / 1000)];
  if (info.status === "rejected") lines.push(`Limited by the ${String(info.rateLimitType ?? "unknown").replace("_", "-")} window`);
  return lines.join("\n");
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
  pi.registerCommand("api-cost", {
    description: "Show active-branch token usage and estimated API cost",
    async handler(args, ctx) {
      if (args.trim()) throw new Error("Usage: /api-cost");
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, requests = 0;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const usage = entry.message.usage;
        input += usage.input; output += usage.output;
        cacheRead += usage.cacheRead; cacheWrite += usage.cacheWrite;
        cost += usage.cost.total; requests++;
      }
      ctx.ui.notify(`${requests} responses · input ${input} · output ${output} · cache read ${cacheRead} · cache write ${cacheWrite}\nEstimated API cost: $${cost.toFixed(6)} (not a billing statement; subscription usage may report $0)`, "info");
    },
  });
  let pending: AbortController | undefined;
  const cancel = () => { pending?.abort(); pending = undefined; };
  pi.on("session_start", cancel);
  pi.on("session_shutdown", cancel);
  pi.on("model_select", cancel);
  pi.on("session_tree", cancel);
  pi.registerCommand("usage", {
    description: "Show plan usage for the selected Claude bridge, OpenAI, or Codex model",
    async handler(args, ctx) {
      if (args.trim()) throw new Error("Usage: /usage");
      const provider = ctx.model?.provider;
      if (provider !== "claude-bridge" && provider !== "openai" && provider !== "openai-codex") throw new Error("Select a Claude bridge, OpenAI, or OpenAI Codex model first");
      cancel();
      if (provider === "claude-bridge") {
        ctx.ui.notify(formatClaudeUsage((globalThis as Record<symbol, unknown>)[claudeLimitsKey]), "info");
        return;
      }
      if (provider === "openai") {
        // Direct OAuth tokens cannot use the legacy Codex quota endpoint.
        ctx.ui.notify("ChatGPT usage\nIn-terminal quota is unavailable for Sign in with ChatGPT.\nManage usage: https://chatgpt.com/settings/usage", "info");
        return;
      }
      const controller = new AbortController(); pending = controller;
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
        if (controller.signal.aborted) return;
        const data = await fetchUsage(auth?.auth.apiKey ?? "", controller.signal);
        if (!controller.signal.aborted) ctx.ui.notify(formatUsage(data), "info");
      } catch {
        if (pending === controller) ctx.ui.notify("Unable to load Codex usage. Check /login openai-codex and connectivity.", "warning");
      } finally { clearTimeout(timeout); if (pending === controller) pending = undefined; }
    },
  });
}
