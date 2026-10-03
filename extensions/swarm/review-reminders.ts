import { reviewAfterSeconds, reviews } from "./coordination.ts";
import type { Run } from "./state.ts";

const promptLimit = 3;
export function reviewPrompt(queue: ReturnType<typeof reviews>) {
  const items = queue.slice(0, promptLimit).map(item => {
    const integration = item.integratedRevisions.length ? "; code integration recorded, handoff undecided" : "";
    return `${item.name.slice(0, 80)} (${item.nodeId}, revision ${item.revision}, waiting ${item.waitingSeconds ?? "unknown"} seconds${item.overdue ? ", overdue" : ""}${integration})`;
  });
  if (queue.length > promptLimit) items.push(`${queue.length - promptLimit} more; inspect the full queue with swarm_reviews`);
  return `Pending direct-child reviews, oldest first (${queue.length}): ${items.join("; ") || "none"}. Inspect with swarm_reviews, then record an explicit swarm_review decision before follow-on assignments. Integration evidence is parent-reported and may cover only some revisions; it does not decide the handoff. Never auto-accept.`;
}

// One aggregate steering reminder per owner every five minutes, not one per worker.
export class ReviewReminders {
  private scope?: string;
  private last?: number;
  private readonly seen = new Map<string, number>();
  next(run: Run, owner: string, now = Date.now()) {
    const scope = `${run.id}:${owner}`;
    if (scope !== this.scope) { this.reset(); this.scope = scope; }
    const queue = reviews(run, owner, now);
    const keys = new Set(queue.map(item => `${item.nodeId}:${item.revision}`));
    for (const key of this.seen.keys()) if (!keys.has(key)) this.seen.delete(key);
    if (!queue.length) { this.last = undefined; return; }
    let due = false;
    for (const item of queue) {
      const key = `${item.nodeId}:${item.revision}`;
      if (!this.seen.has(key)) this.seen.set(key, now);
      // Legacy records keep an unknown age; local observation only schedules reminders.
      if (item.overdue || (item.waitingSeconds === null && now - this.seen.get(key)! >= reviewAfterSeconds * 1000)) due = true;
    }
    if (!due || (this.last !== undefined && now - this.last < reviewAfterSeconds * 1000)) return;
    this.last = now;
    return reviewPrompt(queue);
  }
  reset() { this.scope = undefined; this.last = undefined; this.seen.clear(); }
}
