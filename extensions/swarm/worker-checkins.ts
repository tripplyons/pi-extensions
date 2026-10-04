import { terminal, type Node, type Run } from "./state.ts";
import { activeJob, type Health } from "./coordination.ts";

const clip = (text: string) => text.length > 100 ? `${text.slice(0, 100)}…` : text;
// One line per worker spares the parent separate swarm_health and swarm_reload status calls.
function line(node: Node, now: number, snapshot?: Health) {
  const facts: string[] = [node.status];
  if (node.activity) facts.push(`${node.activity.status} ${Math.max(0, Math.round((now - Date.parse(node.activity.updated)) / 1000))}s ago: "${clip(node.activity.detail.replace(/\s+/g, " "))}"`);
  if (node.permission && node.permission.status !== "released") facts.push(`permission ${node.permission.status}`);
  if (node.reload && node.reload.stage !== "released") facts.push(`reload ${node.reload.stage}`);
  if (snapshot?.error) facts.push("jobs unknown");
  else if (snapshot) facts.push(`${snapshot.jobs.filter(activeJob).length} active jobs`);
  if (snapshot?.state.startsWith("quiet")) facts.push(`${snapshot.state} ${snapshot.quietSeconds}s`);
  if (snapshot?.process === "missing") facts.push("no pane");
  return `- ${node.name.slice(0, 80)} (${node.id}): ${facts.join("; ")}`;
}

// A delivered reminder schedules the next check; a queued reminder cannot pile up.
export class WorkerCheckins {
  private scope?: string;
  private due?: number;
  private queuedAt?: number;
  next(run: Run, owner: string, now = Date.now(), health: Health[] = []) {
    const scope = `${run.id}:${owner}`;
    if (this.scope !== scope) { this.reset(); this.scope = scope; }
    const parent = run.nodes[owner];
    if (terminal(parent.status) || parent.status === "review") return;
    const children = Object.values(run.nodes).filter(node => node.parent === owner && !terminal(node.status) && node.status !== "review");
    if (!children.length) { this.due = undefined; return; }
    this.due ??= now + 300_000;
    if (this.queuedAt !== undefined || now < this.due) return;
    this.queuedAt = now;
    return {
      content: `Swarm worker check-in: ${children.length} active direct children. Review the state below, then use swarm_health, swarm_tree or swarm_observe for workers with unclear progress. Check owned job output before deciding a quiet worker is stalled. Report progress, blockers, and the next check time. Respect permission waits; do not automatically stop, restart, release, or assign follow-on work. Latest worker state (self-reported activity is not proof of progress):\n${children.slice(0, 10).map(node => line(node, now, health.find(entry => entry.nodeId === node.id))).join("\n")}${children.length > 10 ? "\nMore workers in swarm_tree." : ""}`,
      queuedAt: new Date(now).toISOString(),
    };
  }
  delivered(runId: string, owner: string, queuedAt: string, now = Date.now()) {
    if (this.scope !== `${runId}:${owner}` || this.queuedAt !== Date.parse(queuedAt)) return false;
    this.queuedAt = undefined;
    this.due = now + 300_000;
    return true;
  }
  reset() { this.scope = undefined; this.due = undefined; this.queuedAt = undefined; }
}
