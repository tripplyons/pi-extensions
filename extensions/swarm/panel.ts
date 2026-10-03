import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { descendants, terminal, type Run, type Status } from "./state.ts";
import { handoffStatus } from "./prompts.ts";
export type Paint = (color: ThemeColor, text: string) => string;
const colors: Record<Status, ThemeColor> = { starting: "warning", running: "success", review: "accent", accepted: "dim", rejected: "dim", stopped: "dim", failed: "error" };
export function elapsed(since: string | undefined, now: number) {
  if (!since) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
}
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
// Lists nonterminal descendants as a tree. Terminal workers are counted, not marked delivered.
export function panel(run: Run, scope: string, live: Set<string>, width: number, paint: Paint, now = Date.now()) {
  const nodes = descendants(run, scope), active = nodes.filter(node => !terminal(node.status));
  const base = run.nodes[scope].depth + 1;
  const names = active.map(node => "  ".repeat(node.depth - base) + node.name);
  const nameWidth = Math.min(24, Math.max(0, ...names.map(visibleWidth)));
  const header = [paint("accent", "swarm"), `${active.length} active (${active.filter(node => node.status === "review").length} awaiting-parent)`, `${nodes.length - active.length} terminal`, paint("dim", run.objective)].join(paint("dim", " · "));
  const rows = active.map((node, index) => {
    const unread = run.messages.filter(message => message.to === node.id && !message.read).length;
    const model = node.current ?? node.launch;
    const records = node.delivery ?? [];
    const code = records.length ? `${records.filter(record => record.reviewed).length} reviewed, ${records.filter(record => record.tested).length} tested, ${records.filter(record => record.integrated).length} integrated (${records.length} recorded)` : "unrecorded";
    const activity = node.status === "running" ? node.activity?.status ?? "unknown" : undefined;
    const parts = [
      pad(truncateToWidth(names[index], nameWidth), nameWidth),
      paint(node.status === "review" || activity?.startsWith("waiting") ? "warning" : activity === "unknown" ? "muted" : colors[node.status], pad(activity ?? (node.status === "review" ? "await-parent" : node.status), 8)),
      pad(elapsed(node.started, now), 6),
      activity && node.activity ? paint("dim", `reported ${elapsed(node.activity.updated, now)} ago`) : "",
      live.has(node.id) ? "" : paint("error", "no pane"),
      model?.model ? paint("muted", model.model + (model.thinking ? `:${model.thinking}` : "")) : "",
      node.result ? paint("muted", `${node.status === "review" ? "handoff" : "previous handoff"} ${handoffStatus(node)}; code ${code}`) : "",
      unread ? paint("warning", `${unread} unread`) : "",
      paint("dim", node.task.replace(/\s+/g, " ")),
    ];
    return "  " + parts.filter(Boolean).join("  ");
  });
  if (!active.length) rows.push(paint("dim", "  No active workers"));
  return [header, ...rows].map(line => truncateToWidth(line, width));
}
