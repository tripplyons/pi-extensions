import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { historyItems, historyNotice, readHistory, type History } from "../../lib/session-history.ts";

export type Scope = "project" | "all";
type Session = { id: string; path?: string; cwd: string; name?: string };
export type SearchRequest = { query: string; scope?: Scope; includeTools?: boolean; limit?: number; offset?: number };

export async function sessions(ctx: ExtensionContext, scope: Scope = "project", signal?: AbortSignal): Promise<Session[]> {
  if (scope !== "project" && scope !== "all") throw new Error("scope must be project or all");
  const directory = ctx.sessionManager.getSessionDir();
  const candidates = scope === "all"
    ? (await Promise.all([SessionManager.listAll(undefined, signal), SessionManager.listAll(directory, undefined, signal)])).flat()
    : await SessionManager.list(ctx.cwd, directory, undefined, signal);
  const unique = new Map(candidates.filter(item => scope === "all" || resolve(item.cwd) === resolve(ctx.cwd)).map(item => [item.path, { id: item.id, path: item.path, cwd: item.cwd, name: item.name }]));
  const current = ctx.sessionManager.getHeader();
  if (current) unique.set(ctx.sessionManager.getSessionFile() ?? `current:${current.id}`, {
    id: current.id, path: ctx.sessionManager.getSessionFile(), cwd: current.cwd, name: ctx.sessionManager.getSessionName(),
  });
  return [...unique.values()];
}

export async function loadSession(ctx: ExtensionContext, session: Session, signal?: AbortSignal): Promise<History> {
  signal?.throwIfAborted();
  if (session.id === ctx.sessionManager.getSessionId() && session.path === ctx.sessionManager.getSessionFile()) {
    return { header: ctx.sessionManager.getHeader()!, entries: ctx.sessionManager.getEntries(), leafId: ctx.sessionManager.getLeafId(), warnings: [] };
  }
  if (!session.path) throw new Error("Session has no saved file");
  const history = await readHistory(session.path, signal);
  if (history.header.id !== session.id) throw new Error("Session changed during discovery; search again");
  return history;
}

export async function findSession(ctx: ExtensionContext, sessionId: string, scope: Scope = "project", signal?: AbortSignal): Promise<Session> {
  const matches = (await sessions(ctx, scope, signal)).filter(item => item.id === sessionId);
  if (!matches.length) throw new Error("Session not found in this scope. Use session_search to find an exact sessionId; scope=all explicitly searches other projects.");
  if (matches.length > 1) throw new Error("Ambiguous sessionId: multiple saved sessions use this ID");
  return matches[0];
}

export async function searchSessions(ctx: ExtensionContext, request: SearchRequest, signal?: AbortSignal) {
  const { query, includeTools = false, scope = "project", limit = 20, offset = 0 } = request;
  if (typeof query !== "string" || !query.trim() || query.length > 1000) throw new Error("query must contain 1 to 1000 characters");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  const terms = [...new Set(query.toLowerCase().trim().split(/\s+/))];
  const candidates = await sessions(ctx, scope, signal), warnings: string[] = [];
  const matches: Array<{ sessionId: string; path?: string; name?: string; cwd: string; entryId: string; timestamp: string; kind: string; activeBranch: boolean; summary: boolean; snippet: string }> = [];
  let total = 0, scanned = 0;
  for (const session of candidates) {
    signal?.throwIfAborted();
    try {
      const history = await loadSession(ctx, session, signal); scanned++;
      warnings.push(...history.warnings.map(warning => `${session.id}: ${warning}`));
      for (const item of [...historyItems(history, includeTools)].reverse()) {
        const lower = item.text.toLowerCase();
        if (!terms.every(term => lower.includes(term))) continue;
        const at = Math.max(0, lower.indexOf(terms[0]) - 100);
        if (total >= offset && matches.length < limit) matches.push({ sessionId: session.id, path: session.path, name: session.name, cwd: session.cwd,
          entryId: item.entryId, timestamp: item.timestamp, kind: item.kind, activeBranch: item.activeBranch, summary: item.summary,
          snippet: `${at ? "..." : ""}${item.text.slice(at, at + 500)}${at + 500 < item.text.length ? "..." : ""}` });
        total++;
      }
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`${session.id}: ${String(error)}`);
    }
  }
  return { notice: historyNotice, query, scope, total, scanned, matches, nextOffset: offset + matches.length < total ? offset + matches.length : null,
    warnings: warnings.slice(0, 20), omittedWarnings: Math.max(0, warnings.length - 20) };
}
