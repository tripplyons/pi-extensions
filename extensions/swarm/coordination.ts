import { randomUUID } from "node:crypto";
import { descendants, ownedChild, setDirective, terminal, type Node, type Run, type SwarmStore } from "./state.ts";
import type { Swarm } from "./controller.ts";
import { resumeGrace } from "./error-resume.ts";

export type Permission = { status: "released" | "waiting-approval" | "waiting-dependency" | "checkpoint-hold"; reason: string; updated: string; source: "parent" | "worker" };
export type Barrier = { id: string; owner: string; created: string; phase: "checkpoint" | "restarting" | "failed" | "ready" | "released" | "cancelled"; error?: string; members: string[] };
export type OwnedJob = { id: string; status: string; source: "bash" | "tmux" };
export type Health = { nodeId: string; process: "present" | "missing"; state: "recent" | "quiet-with-job" | "quiet-no-job" | "unknown" | "awaiting-review" | "errored"; quietSeconds: number | null; jobs: OwnedJob[]; error?: string };
export const activeJob = (job: OwnedJob) => ["queued", "running", "stopping"].includes(job.status);
export const reviewAfterSeconds = 300;
export function reviews(run: Run, owner: string, now = Date.now()) {
  return Object.values(run.nodes).filter(node => node.parent === owner && node.status === "review").map(node => {
    const submitted = node.handoff?.submitted ?? run.messages.findLast(message => message.from === node.id && message.to === owner && message.text.startsWith("Awaiting parent review:"))?.created;
    const waitingSeconds = submitted && Number.isFinite(Date.parse(submitted)) ? Math.max(0, Math.floor((now - Date.parse(submitted)) / 1000)) : null;
    return { nodeId: node.id, name: node.name, parent: owner, revision: node.handoff?.revision ?? 1, submitted: submitted ?? null,
      waitingSeconds, overdue: waitingSeconds !== null && waitingSeconds >= reviewAfterSeconds,
      integratedRevisions: node.delivery?.filter(record => record.integrated).map(record => record.revision) ?? [] };
  }).sort((a, b) => (a.submitted ?? "9999").localeCompare(b.submitted ?? "9999") || a.nodeId.localeCompare(b.nodeId));
}
export function health(node: Node, live: boolean, jobs: OwnedJob[], quietAfter: number, now = Date.now(), error?: string): Health {
  const last = node.activity?.updated ?? node.started;
  const quietSeconds = last && Number.isFinite(Date.parse(last)) ? Math.max(0, Math.floor((now - Date.parse(last)) / 1000)) : null;
  const state = node.status === "review" ? "awaiting-review" : node.status === "running" && node.activity?.status === "errored" && !(node.activity.resume && Date.parse(node.activity.resume) + resumeGrace > now) ? "errored" : error || quietSeconds === null ? "unknown" : quietSeconds < quietAfter ? "recent" : jobs.some(activeJob) ? "quiet-with-job" : "quiet-no-job";
  return { nodeId: node.id, process: live ? "present" : "missing", state, quietSeconds, jobs, error };
}
export const shortRevision = (revision?: string) => revision?.slice(0, 8) ?? "unknown";
// Name the side that must reload so the parent does not guess.
export function revisionMismatch(parent: string | undefined, members: Node[], installed?: string) {
  const list = members.map(node => `${node.name} (${node.id}) on ${shortRevision(node.runtime?.revision)}`).join(", ");
  const facts = `Package revisions must match before release. Parent runs ${shortRevision(parent)}${installed ? `; installed package is ${shortRevision(installed)}` : ""}. Mismatched members: ${list}.`;
  if (installed && parent !== installed && members.every(node => node.runtime?.revision === installed)) return `${facts} The members loaded the newer installed package. Reload the parent session (/reload), then release again.`;
  const restart = "call swarm_reload action=restart on this barrier again; it restarts only mismatched or stopped members";
  if (installed && parent === installed) return `${facts} The parent is current. To fix the members, ${restart}. Then release.`;
  return `${facts} Reload the parent session (/reload) so it loads the installed package. Then, if members still differ, ${restart}.`;
}
export class ReloadBarrier {
  constructor(readonly store: SwarmStore, readonly swarm: Swarm, readonly jobs: (node: Node) => Promise<OwnedJob[]>) {}
  async request(runId: string, actor: string, ids?: string[]) {
    return this.store.update(runId, run => {
      if (run.nodes[actor]?.status !== "running") throw new Error("Only running parents request reloads");
      const members = ids ?? Object.values(run.nodes).filter(node => node.parent === actor && node.status === "running").map(node => node.id);
      if (!members.length || new Set(members).size !== members.length) throw new Error("Reload requires distinct running direct children");
      for (const id of members) {
        const node = ownedChild(run, actor, id);
        if (node.status !== "running" || node.replacement) throw new Error("Reload requires running workers without pending replacement");
        if (node.reload && node.reload.stage !== "released") throw new Error("Worker already belongs to a reload barrier");
      }
      const barrier: Barrier = { id: randomUUID(), owner: actor, created: new Date().toISOString(), phase: "checkpoint", members };
      (run.barriers ??= {})[barrier.id] = barrier;
      for (const id of members) {
        const node = run.nodes[id], messageId = randomUUID();
        const running = descendants(run, id).filter(child => !terminal(child.status)).length;
        const text = `Reload checkpoint ${barrier.id}: finish only the current bounded step, stop or finish owned jobs, and call swarm_reload action=checkpoint alone with barrierId and a self-contained checkpoint. ${running ? `${running} running descendant worker${running === 1 ? "" : "s"} will keep running through the restart; list each one's ID, assignment and state in the checkpoint. ` : ""}Do not submit a handoff or start follow-on work. Wait for restart and a separate explicit release.`;
        node.reload = { barrier: barrier.id, stage: "requested" };
        node.permission = { status: "checkpoint-hold", reason: text, source: "parent", updated: barrier.created };
        setDirective(run, node, { text, source: "parent", created: barrier.created, messageId });
        node.activity = { status: "instruction-queued", detail: text, updated: barrier.created, source: "instruction" };
        run.messages.push({ id: messageId, from: actor, to: id, kind: "instruction", text, created: barrier.created, read: false });
      }
      return barrier;
    });
  }
  async checkpoint(runId: string, actor: string, barrierId: string, text: string) {
    if (!text.trim()) throw new Error("Checkpoint must contain recovery details");
    const run = await this.store.read(runId), node = run.nodes[actor];
    if (!node || node.reload?.barrier !== barrierId) throw new Error("Worker is not a member of this reload barrier");
    if ((await this.jobs(node)).some(activeJob)) throw new Error("Finish or stop owned jobs before checkpointing");
    return this.store.update(runId, state => {
      const worker = state.nodes[actor], barrier = state.barriers?.[barrierId];
      if (!barrier || barrier.phase !== "checkpoint" || worker.reload?.stage !== "requested" || worker.status !== "running") throw new Error("Checkpoint is not pending");
      worker.reload.stage = "checkpointed"; worker.reload.checkpoint = text;
      const messageId = randomUUID(), created = new Date().toISOString();
      state.messages.push({ id: messageId, from: actor, to: barrier.owner, kind: "message", read: false, created, text: `Reload ${barrierId}: ${worker.name} checkpointed. Recovery details are in swarm_reload action=status.` });
      return worker.reload;
    });
  }
  async restart(runId: string, actor: string, barrierId: string) {
    const barrier = await this.store.update(runId, run => {
      const entry = run.barriers?.[barrierId];
      if (!entry || entry.owner !== actor) throw new Error("Only the barrier owner may restart it");
      // A ready barrier restarts again to bring mismatched or stopped members onto the parent's revision.
      if (!["checkpoint", "failed", "ready"].includes(entry.phase)) throw new Error(entry.phase === "restarting" ? "Barrier restart is already in progress; inspect status, or cancel the barrier if it is stuck" : "Barrier is finished; request a new reload barrier");
      if (entry.members.some(id => !["checkpointed", "restarted", "ready"].includes(run.nodes[id].reload?.stage ?? ""))) throw new Error("Wait for every worker checkpoint before restart");
      entry.phase = "restarting"; delete entry.error; return entry;
    });
    try {
      for (const id of barrier.members) {
        const run = await this.store.read(runId), node = ownedChild(run, actor, id);
        const current = node.reload!.stage === "restarted" || (node.reload!.stage === "ready" && node.runtime?.revision === run.nodes[actor].runtime?.revision);
        if (current && await this.swarm.workers.alive(id)) continue;
        if ((await this.jobs(node)).some(activeJob)) throw new Error(`Worker ${node.name} still owns active jobs`);
        // Stop only the member process; its descendants keep running.
        await this.swarm.stopNodes(runId, [node]);
        await this.store.update(runId, state => { state.nodes[id].reload!.stage = "restarted"; });
        await this.swarm.restart(runId, actor, id);
      }
      return this.store.update(runId, run => {
        const entry = run.barriers![barrierId];
        if (entry.members.every(id => run.nodes[id].reload?.stage === "ready")) entry.phase = "ready";
        return entry;
      });
    } catch (error) {
      await this.store.update(runId, run => { if (run.barriers![barrierId].phase === "restarting") Object.assign(run.barriers![barrierId], { phase: "failed", error: String(error) }); });
      throw error;
    }
  }
  // Cancel leaves members on a parent permission wait. Their checkpoints return to the parent for recovery.
  async cancel(runId: string, actor: string, barrierId: string) {
    return this.store.update(runId, run => {
      const barrier = run.barriers?.[barrierId];
      if (!barrier || barrier.owner !== actor) throw new Error("Only the barrier owner may cancel it");
      if (barrier.phase === "released" || barrier.phase === "cancelled") throw new Error(`Barrier is already ${barrier.phase}`);
      const created = new Date().toISOString(), text = `Reload ${barrierId} was cancelled. Stay on hold and wait for an instruction from your parent.`;
      const members = barrier.members.map(id => {
        const node = run.nodes[id], checkpoint = node.reload?.barrier === barrierId ? node.reload.checkpoint ?? null : null;
        if (node.reload?.barrier === barrierId) delete node.reload;
        if (node.permission?.status === "checkpoint-hold") node.permission = { status: "waiting-approval", reason: text, source: "parent", updated: created };
        if (!terminal(node.status)) run.messages.push({ id: randomUUID(), from: actor, to: id, kind: "message", text, created, read: false });
        return { nodeId: id, name: node.name, status: node.status, checkpoint };
      });
      barrier.phase = "cancelled";
      return { barrier: barrierId, phase: barrier.phase, members, next: "Send each running member an instruction with permission=released, or request a new reload barrier. Restart stopped members with swarm_restart and a task built from the checkpoint." };
    });
  }
  // installed is the package revision on disk; it tells which side must reload when revisions differ.
  async release(runId: string, actor: string, barrierId: string, assignments: { nodeId: string; task: string }[], installed?: string) {
    return this.store.update(runId, run => {
      const barrier = run.barriers?.[barrierId];
      if (!barrier || barrier.owner !== actor) throw new Error("Only the barrier owner may release it");
      if (barrier.phase !== "ready") throw new Error("Wait for every worker readiness acknowledgment before release");
      if (assignments.length !== barrier.members.length || new Set(assignments.map(item => item.nodeId)).size !== assignments.length || assignments.some(item => !barrier.members.includes(item.nodeId) || !item.task.trim())) throw new Error("Release requires one explicit bounded assignment for every member");
      if (assignments.some(item => run.nodes[item.nodeId].status !== "running" || run.nodes[item.nodeId].reload?.stage !== "ready")) throw new Error("Every member must still be running and ready");
      const parent = run.nodes[actor].runtime?.revision;
      const mismatched = assignments.map(item => run.nodes[item.nodeId]).filter(node => !parent || node.runtime?.revision !== parent);
      if (mismatched.length) throw new Error(revisionMismatch(parent, mismatched, installed));
      const created = new Date().toISOString();
      for (const item of assignments) {
        const node = run.nodes[item.nodeId];
        const messageId = randomUUID();
        node.reload.stage = "released";
        node.permission = { status: "released", reason: item.task, source: "parent", updated: created };
        setDirective(run, node, { text: item.task, source: "parent", created, messageId });
        node.activity = { status: "instruction-queued", detail: item.task, updated: created, source: "instruction" };
        run.messages.push({ id: messageId, from: actor, to: item.nodeId, kind: "instruction", text: item.task, created, read: false });
      }
      barrier.phase = "released"; return barrier;
    });
  }
}
