import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { descendants, terminal, type Run } from "./state.ts";
import { activeJob, reviews, type Health } from "./coordination.ts";
export type Paint = (color: ThemeColor, text: string) => string;
export function elapsed(since: string | undefined, now: number) {
  if (!since || !Number.isFinite(Date.parse(since))) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
}
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
// Lists nonterminal descendants as a tree. Terminal workers are counted, not marked delivered.
export function panel(run: Run, scope: string, live: Set<string>, width: number, paint: Paint, now = Date.now(), snapshots: Health[] = []) {
  const nodes = descendants(run, scope), active = nodes.filter(node => !terminal(node.status));
  const base = run.nodes[scope].depth + 1;
  const names = active.map(node => "  ".repeat(node.depth - base) + node.name);
  const ages = active.map(node => elapsed(node.started, now) || "?");
  const nameWidth = Math.min(24, Math.max(1, Math.floor(width / 3)), Math.max(0, ...names.map(visibleWidth)));
  const ageWidth = Math.max(0, ...ages.map(visibleWidth));
  const header = [paint("accent", "swarm"), `${active.length} active (${active.filter(node => node.status === "review").length} awaiting-parent)`, `${nodes.length - active.length} terminal`, paint("dim", run.objective)].join(paint("dim", " · "));
  const rows = active.map((node, index) => {
    const activity = node.status === "running" ? node.activity?.status : undefined;
    const snapshot = snapshots.find(item => item.nodeId === node.id);
    const review = reviews(run, node.parent!, now).find(item => item.nodeId === node.id);
    const flags: string[] = [];
    if (!live.has(node.id)) flags.push(paint("error", "no pane"));
    if (review) {
      flags.push(paint("warning", `await-parent ${elapsed(review.submitted ?? undefined, now) || "?"}`));
      if (review.overdue) flags.push(paint("warning", "review overdue"));
      if (review.integratedRevisions.length) flags.push(paint("warning", "integrated; undecided"));
    } else {
      if (node.status === "starting") flags.push(paint("warning", "starting"));
      else if (!activity) flags.push(paint("muted", "activity unknown"));
      else if (activity !== "working" && activity !== "tool-active") {
        flags.push(paint(activity === "checking-in" ? "muted" : "warning", `${activity} ${elapsed(node.activity!.updated, now) || "?"} ago`));
      }
      const permission = node.permission?.status;
      // Waiting reports already explain these matching permission holds.
      const reportedHold = (activity === "waiting-instructions" && permission === "waiting-approval") || (activity === "waiting-dependency" && permission === "waiting-dependency");
      if (permission !== "released" && !reportedHold) flags.push(paint("warning", permission ?? "permission unknown"));
    }
    if (!node.runtime || !run.nodes[scope].runtime) flags.push(paint("warning", "version unknown"));
    else if (node.runtime.revision !== run.nodes[scope].runtime.revision) flags.push(paint("warning", `version differs:${node.runtime.revision.slice(0, 8)}`));
    if (snapshot?.state.startsWith("quiet")) flags.push(paint("warning", `${snapshot.state} (${snapshot.jobs.filter(activeJob).length} live jobs)`));
    if (snapshot?.error) flags.push(paint("error", "health error"));

    const message = run.messages.findLast(message => message.from === node.id && message.kind === "message");
    // Tool boundaries must not replace the worker's last message with a tool name.
    const report = node.activity && ["working", "waiting-instructions", "waiting-dependency", "checking-in"].includes(node.activity.status) ? node.activity.detail : undefined;
    const preview = node.status === "review" ? node.result ?? message?.text : message?.text ?? report;
    const parts = [
      pad(truncateToWidth(names[index], nameWidth), nameWidth),
      paint("dim", pad(ages[index], ageWidth)),
      ...flags,
      (preview ?? "No messages yet").replace(/\s+/g, " ").trim(),
    ];
    return "  " + parts.join("  ");
  });
  if (!active.length) rows.push(paint("dim", "  No active workers"));
  return [header, ...rows].map(line => truncateToWidth(line, width));
}
