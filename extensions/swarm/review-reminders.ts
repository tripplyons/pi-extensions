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

// Delivery, not the unrelated session message queue, controls duplicate suppression.
export class ReviewReminders {
  private scope?: string;
  private queuedAt?: number;
  private deliveredAt?: number;
  private scheduledAt?: number;
  private readonly seen = new Map<string, number>();
  snapshot(run: Run, owner: string, now = Date.now()) {
    const scope = `${run.id}:${owner}`;
    if (scope !== this.scope) { this.reset(); this.scope = scope; }
    const queue = reviews(run, owner, now);
    const keys = new Set(queue.map(item => `${item.nodeId}:${item.revision}`));
    for (const key of this.seen.keys()) if (!keys.has(key)) this.seen.delete(key);
    const delay = reviewAfterSeconds * 1000;
    const deadlines = queue.map(item => {
      const key = `${item.nodeId}:${item.revision}`;
      if (!this.seen.has(key)) this.seen.set(key, now);
      // Legacy records keep an unknown age; local observation only schedules reminders.
      return item.waitingSeconds === null ? this.seen.get(key)! + delay : Date.parse(item.submitted!) + delay;
    });
    this.scheduledAt = deadlines.length ? Math.max(Math.min(...deadlines), this.deliveredAt === undefined ? 0 : this.deliveredAt + delay) : undefined;
    return {
      state: this.queuedAt !== undefined ? "queued" : this.scheduledAt === undefined ? "idle" : this.deliveredAt !== undefined ? "delivered" : "scheduled",
      scheduledAt: this.scheduledAt === undefined ? undefined : new Date(this.scheduledAt).toISOString(),
      queuedAt: this.queuedAt === undefined ? undefined : new Date(this.queuedAt).toISOString(),
      deliveredAt: this.deliveredAt === undefined ? undefined : new Date(this.deliveredAt).toISOString(),
    };
  }
  next(run: Run, owner: string, now = Date.now()) {
    this.snapshot(run, owner, now);
    if (this.queuedAt !== undefined || this.scheduledAt === undefined || now < this.scheduledAt) return;
    this.queuedAt = now;
    return reviewPrompt(reviews(run, owner, now));
  }
  delivered(runId: string, owner: string, queuedAt: string, now = Date.now()) {
    if (this.scope !== `${runId}:${owner}` || this.queuedAt !== Date.parse(queuedAt)) return false;
    this.queuedAt = undefined;
    this.deliveredAt = now;
    return true;
  }
  reset() { this.scope = undefined; this.queuedAt = undefined; this.deliveredAt = undefined; this.scheduledAt = undefined; this.seen.clear(); }
}
