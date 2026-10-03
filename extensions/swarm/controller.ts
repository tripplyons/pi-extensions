import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SwarmStore, descendants, ownedChild, terminal, type Node, type Run } from "./state.ts";
import { git, prepareWorktree, preflightWorktree, removeWorktree, type DirtyMode } from "./git.ts";
import { inheritWorktree } from "./replacement.ts";
import { Workers, type Launch } from "./worker.ts";
export type WorkerRuntime = Pick<Workers, "start" | "stop" | "observe" | "alive">;
export class Swarm {
  constructor(readonly store: SwarmStore, readonly workers: WorkerRuntime, readonly stopJobs: (node: Node) => Promise<void>) {}
  async owned(runId: string, actor: string, child: string) {
    return ownedChild(await this.store.read(runId), actor, child);
  }
  async launch(run: Run, node: Node, options: Pick<Launch, "model" | "thinking" | "fast"> = {}) {
    if (!node.worktree) throw new Error("Worker has no worktree");
    const launch = { ...node.launch, ...options };
    const generation = randomUUID();
    // Save before process creation so a failed launch can be retried faithfully.
    await this.store.update(run.id, state => { state.nodes[node.id].launch = launch; state.nodes[node.id].generation = generation; delete state.nodes[node.id].runtime; delete state.nodes[node.id].current; });
    const launched = await this.workers.start({ run: run.id, node: node.id, cwd: node.worktree.cwd,
      directory: join(this.store.path(run.id), "workers", node.id), generation, ...launch });
    try {
      await this.store.update(run.id, state => {
        Object.assign(state.nodes[node.id], launched, { status: "running", started: new Date().toISOString() });
      });
    } catch (error) { await this.workers.stop(node.id); throw error; }
  }
  async spawn(runId: string, actor: string, name: string, task: string, mode?: DirtyMode, options: Pick<Launch, "model" | "thinking" | "fast"> = {}) {
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
  async replace(runId: string, actor: string, child: string, name: string, task: string, testedBase: string, options: Pick<Launch, "model" | "thinking" | "fast">) {
    if (!options.model?.trim()) throw new Error("Replacement requires an explicit target model");
    if (!testedBase.trim()) throw new Error("Replacement requires an explicit testedBase");
    const run = await this.store.read(runId);
    const previous = ownedChild(run, actor, child);
    if (await this.workers.alive(child)) throw new Error("Predecessor still has a live pane; accept its handoff first");
    if (!previous.worktree || previous.worktree.shared) throw new Error("Replacement requires a retained isolated Git worktree");
    const assignment = `${task}\n\nPredecessor ${previous.name} (${previous.id})\nOriginal ownership and assignment:\n${previous.task}\n\nAccepted handoff (not proof of code integration):\n${previous.result}\n\nRead swarm_task provenance. The successor starts from the predecessor HEAD with staged, unstaged and untracked WIP copied without a commit. The tested base describes only the reported tests; WIP remains unverified. Ignored files are not copied. Preserve ownership unless this assignment explicitly changes it. Do not repeat or omit pending commits. Commit only when authorized.`;
    const node = await this.store.reserve(runId, actor, name, assignment, child);
    const destination = join(this.store.path(runId), "worktrees", node.id);
    const branch = `pi-swarm/${runId}/${node.id}`;
    const snapshot = join(this.store.path(runId), "replacements", node.id);
    try {
      const inherited = await inheritWorktree(previous, destination, branch, testedBase, snapshot);
      node.worktree = inherited.worktree;
      await this.store.update(runId, state => {
        Object.assign(state.nodes[node.id], { worktree: inherited.worktree, branch, provenance: { predecessor: child, ...inherited.provenance } });
      });
      await this.launch(run, node, options);
      return (await this.store.read(runId)).nodes[node.id];
    } catch (error) {
      // A patch or launch failure keeps its branch, worktree and snapshot for inspection.
      let retained = false;
      try { retained = await git(destination, ["branch", "--show-current"]) === branch; } catch {}
      await this.store.update(runId, state => {
        Object.assign(state.nodes[node.id], { status: "failed", feedback: `${error}\nReplacement snapshot: ${snapshot}` });
        if (retained) Object.assign(state.nodes[node.id], { branch, worktree: { cwd: destination, repository: previous.worktree!.repository, branch, shared: false } });
      });
      throw error;
    }
  }
  async stopNodes(runId: string, nodes: Node[]) {
    // Leaves records/branches intact. Children stop before parents. Returns the IDs of nodes that were active.
    const stopped: string[] = [];
    for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) {
      await this.workers.stop(node.id);
      await this.stopJobs(node);
      await this.store.update(runId, run => {
        if (terminal(run.nodes[node.id].status)) return;
        run.nodes[node.id].status = "stopped"; stopped.push(node.id);
      });
    }
    return stopped;
  }
  async stop(runId: string, actor: string, child: string) {
    const run = await this.store.read(runId);
    const node = ownedChild(run, actor, child);
    await this.stopNodes(runId, [node, ...descendants(run, child)]);
  }
  async kill(runId: string, actor: string) {
    const run = await this.store.read(runId);
    if (actor !== run.root) throw new Error("Only root can stop the entire swarm");
    return this.stopNodes(runId, descendants(run, run.root));
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
    return reviewed;
  }
  async restart(runId: string, actor: string, child: string, options: Pick<Launch, "model" | "thinking" | "fast"> & { task?: string } = {}) {
    const run = await this.store.read(runId);
    const node = ownedChild(run, actor, child);
    if (await this.workers.alive(child)) throw new Error("Worker is already running");
    if (node.replacement) throw new Error("Predecessor is reserved for replacement; do not restart it");
    if (!node.worktree) throw new Error("Worker has no saved worktree");
    if (node.predecessor && !node.provenance) throw new Error("Incomplete replacement snapshot; inspect and recover manually before launch");
    if (descendants(run, child).some(entry => !terminal(entry.status))) throw new Error("Stop descendants before restarting");
    if (node.reload && node.reload.stage !== "released" && node.reload.stage !== "restarted") throw new Error("Use the reload barrier to restart checkpoint members");
    if (options.task !== undefined && !options.task.trim()) throw new Error("Restart task must contain text");
    const prepared = await this.store.update(runId, state => {
      const worker = ownedChild(state, actor, child);
      delete worker.activity;
      if (options.task !== undefined) {
        worker.directive = { text: options.task, source: "restart", created: new Date().toISOString() };
        if (worker.permission?.status !== "checkpoint-hold") worker.permission = { status: "released", reason: options.task, source: "parent", updated: worker.directive.created };
      } else if (!worker.directive && worker.result && worker.permission?.status !== "checkpoint-hold") worker.permission = { status: "waiting-approval", reason: "Restart requires a new bounded assignment", source: "parent", updated: new Date().toISOString() };
      return worker;
    });
    const { task: _task, ...settings } = options;
    await this.launch(run, prepared, settings);
  }
  async cleanup(runId: string, actor: string) {
    const run = await this.store.read(runId);
    if (actor !== run.root) throw new Error("Only root can clean up swarm worktrees");
    const nodes = descendants(run, run.root).filter(node => terminal(node.status) && node.worktree && !node.worktree.shared);
    for (const node of nodes) {
      if (node.replacement) throw new Error("Replacement predecessor worktrees are retained; remove them only after manual provenance review");
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
