import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Worktree } from "./git.ts";
export type Status = "starting" | "running" | "review" | "accepted" | "rejected" | "stopped" | "failed";
export const terminal = (status: Status) => ["accepted", "rejected", "stopped", "failed"].includes(status);
export type Node = {
  id: string; parent?: string; name: string; task: string; depth: number; status: Status;
  worktree?: Worktree; session?: string; pane?: string; result?: string; feedback?: string;
};
export type Message = { id: string; from: string; to: string; kind: "message" | "instruction"; text: string; created: string; read: boolean };
export type Run = { version: 1; id: string; root: string; objective: string; nodes: Record<string, Node>; messages: Message[] };
const nonempty = (value: string, name: string) => { if (!value.trim()) throw new Error(`${name} must contain text`); };
export function ownedChild(run: Run, actor: string, child: string) {
  const node = run.nodes[child];
  if (!run.nodes[actor] || !node || node.parent !== actor) throw new Error("Only a direct parent may manage this worker");
  return node;
}
export function descendants(run: Run, id: string): Node[] {
  return Object.values(run.nodes).filter(node => node.parent === id).flatMap(node => [node, ...descendants(run, node.id)]);
}
export class SwarmStore {
  constructor(readonly root: string) {}
  path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid swarm run ID");
    return join(this.root, id);
  }
  async create(session: string, cwd: string, objective: string) {
    nonempty(objective, "Objective");
    const id = randomUUID(), root = randomUUID();
    const run: Run = { version: 1, id, root, objective, messages: [], nodes: {
      [root]: { id: root, name: "root", task: objective, depth: 0, status: "running", session, worktree: { cwd, repository: cwd, shared: true } },
    } };
    await mkdir(this.path(id), { recursive: true, mode: 0o700 });
    await this.save(run);
    return run;
  }
  async read(id: string): Promise<Run> {
    const run = JSON.parse(await readFile(join(this.path(id), "run.json"), "utf8"));
    if (run.version !== 1 || run.id !== id || !run.nodes?.[run.root] || !Array.isArray(run.messages)) throw new Error("Invalid swarm state");
    return run;
  }
  private async save(run: Run) {
    const temporary = join(this.path(run.id), `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(run), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.path(run.id), "run.json"));
    } finally { await rm(temporary, { force: true }); }
  }
  async update<T>(id: string, change: (run: Run) => T): Promise<T> {
    const lock = join(this.path(id), "lock");
    try { await mkdir(lock); } catch { throw new Error("Swarm state is busy; retry after the current operation finishes"); }
    try {
      const run = await this.read(id);
      const result = change(run);
      await this.save(run);
      return result;
    } finally { await rm(lock, { recursive: true }); }
  }
  async reserve(id: string, actor: string, name: string, task: string) {
    nonempty(name, "Name"); nonempty(task, "Task");
    return this.update(id, run => {
      const parent = run.nodes[actor];
      if (!parent || parent.status !== "running") throw new Error("Only running nodes may spawn");
      if (parent.depth >= 3) throw new Error("Maximum swarm depth is three");
      const child: Node = { id: randomUUID(), parent: actor, name, task, depth: parent.depth + 1, status: "starting" };
      run.nodes[child.id] = child;
      return child;
    });
  }
  async send(id: string, from: string, to: string, kind: Message["kind"], text: string) {
    nonempty(text, "Message");
    return this.update(id, run => {
      const sender = run.nodes[from], recipient = run.nodes[to];
      if (!sender || !recipient || (recipient.parent !== from && sender.parent !== to)) throw new Error("Messages require direct relatives");
      if (kind !== "message" && kind !== "instruction") throw new Error("Invalid message kind");
      if (kind === "instruction" && recipient.parent !== from) throw new Error("Only parents may send instructions");
      const message: Message = { id: randomUUID(), from, to, kind, text, created: new Date().toISOString(), read: false };
      run.messages.push(message); return message;
    });
  }
  async inbox(id: string, actor: string) {
    return this.update(id, run => {
      if (!run.nodes[actor]) throw new Error("Unknown swarm node");
      const messages = run.messages.filter(message => message.to === actor && !message.read);
      for (const message of messages) message.read = true;
      return messages;
    });
  }
  async complete(id: string, actor: string, result: string) {
    nonempty(result, "Result");
    return this.update(id, run => {
      const node = run.nodes[actor];
      if (!node?.parent || node.status !== "running") throw new Error("Only running workers submit results");
      if (descendants(run, actor).some(child => !terminal(child.status))) throw new Error("All descendants must be terminal before completion");
      node.status = "review"; node.result = result; return node;
    });
  }
  async review(id: string, actor: string, child: string, decision: "accept" | "reject" | "request-changes", feedback: string) {
    return this.update(id, run => {
      const node = ownedChild(run, actor, child);
      if (node.status !== "review") throw new Error("Worker has no result awaiting review");
      if (!["accept", "reject", "request-changes"].includes(decision)) throw new Error("Invalid review decision");
      node.status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "running";
      node.feedback = feedback; return node;
    });
  }
}
