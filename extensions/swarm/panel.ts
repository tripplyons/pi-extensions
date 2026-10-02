import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { descendants, terminal, type Run, type Status } from "./state.ts";
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
// Lists the scope's non-terminal descendants as an indented tree; finished workers are only counted.
export function panel(run: Run, scope: string, live: Set<string>, width: number, paint: Paint, now = Date.now()) {
  const nodes = descendants(run, scope), active = nodes.filter(node => !terminal(node.status));
  const base = run.nodes[scope].depth + 1;
  const names = active.map(node => "  ".repeat(node.depth - base) + node.name);
  const nameWidth = Math.min(24, Math.max(0, ...names.map(visibleWidth)));
  const header = [paint("accent", "swarm"), `${active.length} active`, `${nodes.length - active.length} finished`, paint("dim", run.objective)].join(paint("dim", " · "));
  const rows = active.map((node, index) => {
    const unread = run.messages.filter(message => message.to === node.id && !message.read).length;
    const parts = [
      pad(truncateToWidth(names[index], nameWidth), nameWidth),
      paint(colors[node.status], pad(node.status, 8)),
      pad(elapsed(node.started, now), 6),
      live.has(node.id) ? "" : paint("error", "no pane"),
      node.launch?.model ? paint("muted", node.launch.model + (node.launch.thinking ? `:${node.launch.thinking}` : "")) : "",
      unread ? paint("warning", `${unread} unread`) : "",
      paint("dim", node.task.replace(/\s+/g, " ")),
    ];
    return "  " + parts.filter(Boolean).join("  ");
  });
  if (!active.length) rows.push(paint("dim", "  No active workers"));
  return [header, ...rows].map(line => truncateToWidth(line, width));
}
