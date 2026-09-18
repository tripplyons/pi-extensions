import { join } from "node:path";
import { SwarmStore, descendants, ownedChild, terminal, type Node, type Run } from "./state.ts";
import { prepareWorktree, preflightWorktree, removeWorktree, type DirtyMode } from "./git.ts";
import { Workers, type Launch } from "./worker.ts";
export type WorkerRuntime = Pick<Workers, "start" | "stop" | "observe" | "alive">;
export class Swarm {
  constructor(readonly store: SwarmStore, readonly workers: WorkerRuntime, readonly extensions: string[], readonly stopJobs: (node: Node) => Promise<void>) {}
  async owned(runId: string, actor: string, child: string) {
    return ownedChild(await this.store.read(runId), actor, child);
  }
  async launch(run: Run, node: Node, options: Pick<Launch, "model" | "thinking"> = {}) {
    if (!node.worktree) throw new Error("Worker has no worktree");
    const launched = await this.workers.start({ run: run.id, node: node.id, cwd: node.worktree.cwd,
      directory: join(this.store.path(run.id), "workers", node.id), extensions: this.extensions, ...options });
    try {
      await this.store.update(run.id, state => {
        Object.assign(state.nodes[node.id], launched, { status: "running" });
      });
    } catch (error) { await this.workers.stop(node.id); throw error; }
  }
  async spawn(runId: string, actor: string, name: string, task: string, mode?: DirtyMode, options: Pick<Launch, "model" | "thinking"> = {}) {
    const run = await this.store.read(runId);
    const parent = run.nodes[actor];
    if (!parent?.worktree) throw new Error("Unknown parent workspace");
    const node = await this.store.reserve(runId, actor, name, task);
    try {
      const worktree = await prepareWorktree(parent.worktree.cwd, join(this.store.path(runId), "worktrees", node.id), `pi-swarm/${runId}/${node.id}`, mode);
      node.worktree = worktree;
      await this.store.update(runId, state => { state.nodes[node.id].worktree = worktree; state.nodes[node.id].branch = worktree.branch; });
      await this.launch(run, node, options);
      return (await this.store.read(runId)).nodes[node.id];
    } catch (error) {
      await this.store.update(runId, state => { state.nodes[node.id].status = "failed"; state.nodes[node.id].feedback = String(error); });
      // Retain any created worktree and branch for diagnosis/recovery.
      throw error;
    }
  }
  async stopNodes(runId: string, nodes: Node[]) {
    // Leaves records/branches intact. Children stop before parents.
    for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) {
      await this.workers.stop(node.id);
      await this.stopJobs(node);
      await this.store.update(runId, run => { if (!terminal(run.nodes[node.id].status)) run.nodes[node.id].status = "stopped"; });
    }
  }
  async stop(runId: string, actor: string, child: string) {
    const run = await this.store.read(runId);
    const node = ownedChild(run, actor, child);
    await this.stopNodes(runId, [node, ...descendants(run, child)]);
  }
  async kill(runId: string, actor: string) {
    const run = await this.store.read(runId);
    if (actor !== run.root) throw new Error("Only root can stop the entire swarm");
    await this.stopNodes(runId, descendants(run, run.root));
  }
  async review(runId: string, actor: string, child: string, decision: "accept" | "reject" | "request-changes", feedback: string) {
    const node = await this.owned(runId, actor, child);
    if (node.status !== "review") throw new Error("Worker has no result awaiting review");
    if (decision !== "request-changes") {
      if (decision !== "accept" && decision !== "reject") throw new Error("Invalid review decision");
      await this.workers.stop(child);
      await this.stopJobs(node);
    }
    const reviewed = await this.store.review(runId, actor, child, decision, feedback);
    if (decision === "request-changes") await this.store.send(runId, actor, child, "instruction", feedback || "Revise the submitted result and resubmit for review.");
    return reviewed;
  }
  async restart(runId: string, actor: string, child: string, options: Pick<Launch, "model" | "thinking"> = {}) {
    const run = await this.store.read(runId);
    const node = ownedChild(run, actor, child);
    if (await this.workers.alive(child)) throw new Error("Worker is already running");
    if (!node.worktree) throw new Error("Worker has no saved worktree");
    if (descendants(run, child).some(entry => !terminal(entry.status))) throw new Error("Stop descendants before restarting");
    await this.launch(run, node, options);
  }
  async cleanup(runId: string, actor: string) {
    const run = await this.store.read(runId);
    if (actor !== run.root) throw new Error("Only root can clean up swarm worktrees");
    const nodes = descendants(run, run.root).filter(node => terminal(node.status) && node.worktree && !node.worktree.shared);
    for (const node of nodes) {
      if (await this.workers.alive(node.id)) throw new Error("Terminal worker still has a live pane");
      await preflightWorktree(node.worktree!);
    }
    for (const node of nodes) {
      await removeWorktree(node.worktree!);
      await this.store.update(runId, state => { delete state.nodes[node.id].worktree; });
    }
    return nodes.map(node => node.id);
  }
}
