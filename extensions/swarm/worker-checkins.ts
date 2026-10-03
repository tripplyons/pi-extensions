import { terminal, type Run } from "./state.ts";

// A delivered reminder schedules the next check; a queued reminder cannot pile up.
export class WorkerCheckins {
  private scope?: string;
  private due?: number;
  private queuedAt?: number;
  next(run: Run, owner: string, now = Date.now()) {
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
      content: `Swarm worker check-in: ${children.length} active direct children. Inspect swarm_health and swarm_tree now, then use swarm_observe for workers with unclear progress. Check owned job output before deciding a quiet worker is stalled. Report progress, blockers, and the next check time. Respect permission waits; do not automatically stop, restart, release, or assign follow-on work. Workers: ${children.slice(0, 10).map(node => `${node.name.slice(0, 80)} (${node.id})`).join("; ")}${children.length > 10 ? "; more in swarm_tree" : ""}.`,
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
