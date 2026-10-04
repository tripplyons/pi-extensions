import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Worktree } from "./git.ts";
import type { Barrier, Permission } from "./coordination.ts";
export type Status = "starting" | "running" | "review" | "accepted" | "rejected" | "stopped" | "failed";
export const terminal = (status: Status) => ["accepted", "rejected", "stopped", "failed"].includes(status);
export type Handoff = { revision: number; status: "awaiting-parent" | "accepted" | "rejected" | "changes-requested" | "unknown"; feedback?: string; submitted?: string };
export type Evidence = { actor: string; text: string; recorded: string };
export type Delivery = { revision: string; reviewed?: Evidence; tested?: Evidence; integrated?: Evidence };
export type Provenance = {
  predecessor: string; branch: string; head: string; testedBase: string; commits: string[];
  snapshot: string; stagedPatch: string; unstagedPatch: string; untracked: { path: string; sha256: string }[];
};
export type Activity = "working" | "waiting-instructions" | "waiting-dependency";
export type AssignmentMode = "append" | "replace";
function validateAssignmentMode(kind: Message["kind"], mode?: AssignmentMode) {
  if (mode !== undefined && (kind !== "instruction" || !["append", "replace"].includes(mode))) throw new Error("assignmentMode requires an instruction and must be append or replace");
}
function instructionText(node: Node, text: string, mode: AssignmentMode) {
  if (mode === "replace") return text;
  const assignment = currentAssignment(node);
  if (!assignment) throw new Error("No current assignment to append to; use assignmentMode=replace with a new bounded task");
  return `${assignment.text}\n\nAdditional parent instruction (preserve the task above; this update takes precedence where it conflicts):\n${text}`;
}
export function currentAssignment(node: Node) {
  const assignment = node.directive ?? (!node.result ? { text: node.task, source: "original" as const } : undefined);
  return assignment ? { ...assignment, generation: node.assignmentGeneration ?? 1 } : undefined;
}
export function setDirective(run: Run, node: Node, directive: NonNullable<Node["directive"]>) {
  node.assignmentGeneration = (node.assignmentGeneration ?? 1) + 1;
  node.directive = directive;
  delete node.resume;
  for (const message of run.messages) if (message.to === node.id && message.kind === "instruction" && !message.read) {
    message.read = true;
    message.superseded = true;
  }
  return directive;
}
export type Node = {
  id: string; parent?: string; name: string; task: string; depth: number; status: Status;
  launch?: { model?: string; thinking?: string; fast?: boolean };
  current?: { model: string; thinking: string };
  generation?: string;
  assignmentGeneration?: number;
  observedAssignment?: { generation: number; launchGeneration?: string; observed: string };
  runtime?: { revision: string; loaded: string };
  permission?: Permission;
  reload?: { barrier: string; stage: "requested" | "checkpointed" | "restarted" | "ready" | "released"; checkpoint?: string };
  delivery?: Delivery[];
  directive?: { text: string; source: "parent" | "restart"; created: string; messageId?: string };
  activity?: { status: Activity | "checking-in" | "instruction-queued" | "instruction-delivered" | "tool-active" | "errored"; detail: string; updated: string; source?: "worker" | "message" | "instruction" | "tool-boundary" };
  handoff?: Handoff;
  replacement?: { requested: string; successor?: string };
  predecessor?: string;
  provenance?: Provenance;
  resume?: { messageId: string; revision: number; status: "queued" | "delivered" | "observed" };
  worktree?: Worktree; branch?: string; session?: string; pane?: string; started?: string; result?: string; feedback?: string;
};
// Old running/stopped records cannot tell us whether their retained result was accepted.
export function handoffRecord(node: Node): Handoff | undefined {
  if (!node.result) return;
  if (node.handoff) return node.handoff;
  const status = node.status === "review" ? "awaiting-parent" : node.status === "accepted" ? "accepted" : node.status === "rejected" ? "rejected" : "unknown";
  return { revision: 1, status, feedback: node.feedback };
}
export type Message = { id: string; from: string; to: string; kind: "message" | "instruction"; text: string; created: string; read: boolean; superseded?: boolean; assignmentMode?: AssignmentMode };
export type BoardEntry = { value: string; author: string; updated: string; revision: number };
export type Run = { version: 1; id: string; root: string; objective: string; nodes: Record<string, Node>; messages: Message[]; barriers?: Record<string, Barrier>; board?: Record<string, BoardEntry> };
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
  constructor(readonly root: string, readonly lockTimeoutMs = 5000) {}
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
    run.nodes[root].permission = { status: "released", reason: objective, source: "parent", updated: new Date().toISOString() };
    await mkdir(this.path(id), { recursive: true, mode: 0o700 });
    await this.save(run);
    return run;
  }
  async read(id: string): Promise<Run> {
    const run: Run = JSON.parse(await readFile(join(this.path(id), "run.json"), "utf8"));
    if (run.version !== 1 || run.id !== id || !run.nodes?.[run.root] || !Array.isArray(run.messages)) throw new Error("Invalid swarm state");
    for (const node of Object.values(run.nodes)) {
      node.handoff ??= handoffRecord(node);
      const directive = node.directive;
      if (directive && node.activity?.status.startsWith("waiting") && Date.parse(directive.created) > Date.parse(node.activity.updated)) {
        const instruction = run.messages.find(message => message.to === node.id && message.kind === "instruction" &&
          (message.id === directive.messageId || (message.created === directive.created && message.text === directive.text)));
        if (instruction) {
          directive.messageId = instruction.id;
          node.activity = { status: instruction.read ? "instruction-delivered" : "instruction-queued", detail: instruction.text, updated: instruction.created, source: "instruction" };
        }
      }
    }
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
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Swarm state is busy; retry after the current operation finishes");
        await delay(Math.min(25 + Math.floor(Math.random() * 25), deadline - Date.now()));
      }
    }
    try {
      const run = await this.read(id);
      const result = change(run);
      await this.save(run);
      return result;
    } finally { await rm(lock, { recursive: true }); }
  }
  async recordRuntime(id: string, actor: string, revision: string, generation?: string) {
    return this.update(id, run => {
      const node = run.nodes[actor];
      if (!node) throw new Error("Unknown swarm node");
      if (node.parent && node.generation && generation !== node.generation) throw new Error("Worker launch generation is stale");
      node.runtime = { revision, loaded: new Date().toISOString() };
      if (generation && node.reload?.stage === "restarted") {
        node.reload.stage = "ready";
        const barrier = run.barriers?.[node.reload.barrier];
        if (barrier?.phase === "restarting" && barrier.members.every(id => run.nodes[id].reload?.stage === "ready")) barrier.phase = "ready";
        if (barrier) run.messages.push({ id: randomUUID(), from: actor, to: barrier.owner, kind: "message", read: false, created: node.runtime.loaded,
          text: `Reload ${barrier.id}: ${node.name} is ready at package revision ${revision.slice(0, 12)} and remains on checkpoint hold until explicit release.` });
      }
      return node.runtime;
    });
  }
  async reserve(id: string, actor: string, name: string, task: string, predecessor?: string) {
    nonempty(name, "Name"); nonempty(task, "Task");
    return this.update(id, run => {
      const parent = run.nodes[actor];
      if (!parent || parent.status !== "running") throw new Error("Only running nodes may spawn");
      if (parent.depth >= 3) throw new Error("Maximum swarm depth is three");
      const child: Node = { id: randomUUID(), parent: actor, name, task, depth: parent.depth + 1, status: "starting",
        permission: { status: "released", reason: task, source: "parent", updated: new Date().toISOString() } };
      if (predecessor) {
        const previous = ownedChild(run, actor, predecessor);
        if (!previous.replacement) throw new Error("Request a replacement handoff first");
        if (previous.status !== "accepted") throw new Error("Accept the predecessor handoff before replacement");
        if (descendants(run, predecessor).some(node => !terminal(node.status))) throw new Error("All descendants must be terminal before replacement");
        if (previous.replacement.successor) throw new Error("A successor is already reserved; inspect or restart it instead");
        previous.replacement.successor = child.id;
        child.predecessor = predecessor;
      }
      run.nodes[child.id] = child;
      return child;
    });
  }
  async send(id: string, from: string, to: string, kind: Message["kind"], text: string, activity?: Activity, permission?: "released" | "waiting-approval" | "waiting-dependency", assignmentMode?: AssignmentMode) {
    nonempty(text, "Message");
    validateAssignmentMode(kind, assignmentMode);
    if (activity && !["working", "waiting-instructions", "waiting-dependency"].includes(activity)) throw new Error("Invalid activity");
    return this.update(id, run => {
      if (!Object.hasOwn(run.nodes, from) || !Object.hasOwn(run.nodes, to)) throw new Error("Message sender and recipient must be nodes in the same swarm run");
      const sender = run.nodes[from], recipient = run.nodes[to];
      if (from === to) throw new Error("Cannot send a message to yourself");
      if (kind !== "message" && kind !== "instruction") throw new Error("Invalid message kind");
      if (kind === "instruction" && recipient.parent !== from) throw new Error("Only direct parents may send instructions");
      const message: Message = { id: randomUUID(), from, to, kind, text, created: new Date().toISOString(), read: false };
      if (activity) {
        if (sender.status !== "running" || sender.parent !== to || kind !== "message") throw new Error("Only running workers report activity to their parent");
        sender.activity = { status: activity, detail: text, updated: message.created, source: "worker" };
        if (activity.startsWith("waiting") && sender.permission?.status !== "checkpoint-hold") sender.permission = { status: activity === "waiting-dependency" ? "waiting-dependency" : "waiting-approval", reason: text, source: "worker", updated: message.created };
      }
      if (!activity && sender.status === "running" && sender.parent === to && kind === "message") sender.activity = { status: "checking-in", detail: text, updated: message.created, source: "message" };
      if (kind === "instruction") {
        message.assignmentMode = assignmentMode ?? "append";
        message.text = instructionText(recipient, text, message.assignmentMode);
        setDirective(run, recipient, { text: message.text, source: "parent", created: message.created, messageId: message.id });
        recipient.activity = { status: "instruction-queued", detail: text, updated: message.created, source: "instruction" };
      }
      if (permission) {
        if (!["released", "waiting-approval", "waiting-dependency"].includes(permission) || kind !== "instruction") throw new Error("Permission requires a parent instruction");
        if (recipient.permission?.status === "checkpoint-hold") throw new Error("Use reload release to lift a checkpoint hold");
        recipient.permission = { status: permission, reason: text, updated: message.created, source: "parent" };
      }
      run.messages.push(message); return message;
    });
  }
  async broadcast(id: string, actor: string, kind: Message["kind"], text: string, permission?: "released" | "waiting-approval" | "waiting-dependency", assignmentMode?: AssignmentMode) {
    nonempty(text, "Message");
    validateAssignmentMode(kind, assignmentMode);
    if (kind !== "message" && kind !== "instruction") throw new Error("Invalid message kind");
    return this.update(id, run => {
      if (!run.nodes[actor]) throw new Error("Unknown swarm node");
      const children = Object.values(run.nodes).filter(node => node.parent === actor && !terminal(node.status));
      const created = new Date().toISOString();
      const messages: Message[] = children.map(node => ({ id: randomUUID(), from: actor, to: node.id, kind, text, created, read: false }));
      if (kind === "instruction") for (const message of messages) {
        const node = run.nodes[message.to];
        message.assignmentMode = assignmentMode ?? "append";
        message.text = instructionText(node, text, message.assignmentMode);
        setDirective(run, node, { text: message.text, source: "parent", created, messageId: message.id });
        node.activity = { status: "instruction-queued", detail: text, updated: created, source: "instruction" };
        if (permission) {
          if (!["released", "waiting-approval", "waiting-dependency"].includes(permission)) throw new Error("Invalid permission");
          if (node.permission?.status === "checkpoint-hold") throw new Error("Use reload release to lift a checkpoint hold");
          node.permission = { status: permission, reason: text, updated: created, source: "parent" };
        }
      }
      if (permission && kind !== "instruction") throw new Error("Permission requires a parent instruction");
      run.messages.push(...messages);
      return messages;
    });
  }
  // Board entries are shared facts. Authors and their ancestors may change them; a missing value deletes the key.
  async writeBoard(id: string, actor: string, key: string, value?: string) {
    if (!/^[\w./-]{1,100}$/.test(key)) throw new Error("Board keys use 1-100 letters, digits, _, ., / or -");
    if (value !== undefined) { nonempty(value, "Board value"); if (value.length > 8000) throw new Error("Board values are limited to 8000 characters"); }
    return this.update(id, run => {
      if (!run.nodes[actor]) throw new Error("Unknown swarm node");
      const board = run.board ??= {}, entry = board[key];
      if (value === undefined && !entry) throw new Error(`Unknown board key: ${key}`);
      if (entry && entry.author !== actor && !descendants(run, actor).some(node => node.id === entry.author)) throw new Error(`Board key ${key} belongs to ${run.nodes[entry.author]?.name ?? entry.author}; only its author or the author's ancestors may change it`);
      if (value === undefined) { delete board[key]; return { key, deleted: true }; }
      if (!entry && Object.keys(board).length >= 200) throw new Error("Board is full at 200 keys; delete stale keys first");
      board[key] = { value, author: actor, updated: new Date().toISOString(), revision: (entry?.revision ?? 0) + 1 };
      return { key, ...board[key] };
    });
  }
  async inbox(id: string, actor: string) {
    const run = await this.read(id);
    if (!run.nodes[actor]) throw new Error("Unknown swarm node");
    const directive = run.nodes[actor].directive;
    return run.messages.filter(message => message.to === actor && !message.read && !message.superseded &&
      (message.kind !== "instruction" || (directive?.messageId ? message.id === directive.messageId :
        directive && message.created === directive.created && message.text === directive.text)));
  }
  async observeAssignment(id: string, actor: string, generation: number, launchGeneration?: string) {
    return this.update(id, run => {
      const node = run.nodes[actor];
      if (!node || currentAssignment(node)?.generation !== generation) throw new Error("Assignment changed; read swarm_task again");
      if (node.parent && node.generation && node.generation !== launchGeneration) throw new Error("Worker launch generation is stale");
      node.observedAssignment = { generation, launchGeneration: node.generation, observed: new Date().toISOString() };
      return node;
    });
  }
  // An undefined error clears an earlier errored state after a later turn succeeds.
  async recordError(id: string, actor: string, error?: string) {
    return this.update(id, run => {
      const node = run.nodes[actor];
      if (!node?.parent || node.status !== "running") return;
      const updated = new Date().toISOString();
      if (error) node.activity = { status: "errored", detail: `Turn ended with a model error: ${error.slice(0, 500)}`, updated, source: "worker" };
      else if (node.activity?.status === "errored") node.activity = { status: "working", detail: "A later turn completed after the model error.", updated, source: "worker" };
    });
  }
  async observeTool(id: string, actor: string, toolName: string) {
    return this.update(id, run => {
      const node = run.nodes[actor];
      if (!node?.parent || node.status !== "running") return;
      if (!toolName.startsWith("swarm_")) node.activity = { status: "tool-active", detail: `Tool boundary: ${toolName}`, updated: new Date().toISOString(), source: "tool-boundary" };
      if (node?.status === "running" && node.resume && node.resume.status === "delivered") {
        node.resume.status = "observed";
        run.messages.push({ id: randomUUID(), from: actor, to: node.parent!, kind: "message", read: false, created: new Date().toISOString(),
          text: `Resume for handoff revision ${node.resume.revision} observed at a worker tool boundary. This does not prove the revision is complete.` });
      }
    });
  }
  async acknowledge(id: string, actor: string, messageId: string) {
    return this.update(id, run => {
      const message = run.messages.find(message => message.id === messageId);
      if (!message || message.to !== actor) throw new Error("Message does not belong to this node");
      message.read = true;
      const node = run.nodes[actor];
      if (message.kind === "instruction" && node.directive?.messageId === messageId && node.activity?.status === "instruction-queued") {
        node.activity = { status: "instruction-delivered", detail: message.text, updated: new Date().toISOString(), source: "instruction" };
      }
      const resume = node.resume;
      if (resume?.messageId === messageId && resume.status === "queued") resume.status = "delivered";
    });
  }
  async complete(id: string, actor: string, result: string) {
    nonempty(result, "Result");
    return this.update(id, run => {
      const node = run.nodes[actor];
      if (!node?.parent || node.status !== "running") throw new Error("Only running workers submit results");
      if (descendants(run, actor).some(child => !terminal(child.status))) throw new Error("All descendants must be terminal before completion");
      if (node.permission?.status === "checkpoint-hold") throw new Error("Use swarm_reload checkpoint during a reload barrier");
      node.handoff = { revision: (node.handoff?.revision ?? 0) + 1, status: "awaiting-parent", submitted: new Date().toISOString() };
      node.permission = { status: "waiting-approval", reason: "Handoff awaits parent review", source: "worker", updated: node.handoff.submitted! };
      node.status = "review"; node.result = result; delete node.resume; delete node.directive; delete node.activity;
      node.delivery = node.delivery?.filter(record => record.revision !== "result");
      run.messages.push({ id: randomUUID(), from: actor, to: node.parent, kind: "message", read: false, created: new Date().toISOString(),
        text: `Awaiting parent review: handoff revision ${node.handoff.revision}. Read the handoff with swarm_tree nodeId=${actor}. Active counts include review workers.` });
      return node;
    });
  }
  async requestReplacement(id: string, actor: string, child: string) {
    return this.update(id, run => {
      const node = ownedChild(run, actor, child);
      if (!["running", "review", "accepted"].includes(node.status)) throw new Error("Replacement requires a running worker or a submitted handoff");
      if (node.replacement) return node;
      node.replacement = { requested: new Date().toISOString() };
      const messageId = randomUUID();
      if (node.status === "running") {
        const directive = setDirective(run, node, { text: "Finish only the current bounded step and prepare the requested replacement handoff. Do not start follow-on work.", source: "parent", created: node.replacement.requested, messageId });
        node.activity = { status: "instruction-queued", detail: directive.text, updated: directive.created, source: "instruction" };
      }
      if (node.status === "running") run.messages.push({ id: messageId, from: actor, to: child, kind: "instruction", read: false,
        created: node.replacement.requested,
        text: "Prepare a replacement handoff. Finish only the current bounded step, stop your jobs, and submit with swarm_complete alone. State the tested base, all delivered and pending commits, dirty WIP, owned files, checks, blockers, and next steps. Do not auto-commit unverified WIP. Do not start follow-on work.",
      });
      return node;
    });
  }
  async recordDelivery(id: string, actor: string, child: string, revision: string, stage: "reviewed" | "tested" | "integrated", evidence: string) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}|result)$/.test(revision)) throw new Error("revision must be a full commit hash or result for a no-commit handoff");
    if (!["reviewed", "tested", "integrated"].includes(stage)) throw new Error("Invalid delivery stage");
    nonempty(evidence, "Evidence");
    return this.update(id, run => {
      const node = ownedChild(run, actor, child);
      if (!node.result) throw new Error("Worker has no submitted handoff");
      const records = node.delivery ??= [];
      let record = records.find(entry => entry.revision === revision);
      if (!record) { record = { revision }; records.push(record); }
      record[stage] = { actor, text: evidence, recorded: new Date().toISOString() };
      return node;
    });
  }
  async review(id: string, actor: string, child: string, decision: "accept" | "reject" | "request-changes", feedback: string) {
    return this.update(id, run => {
      const node = ownedChild(run, actor, child);
      if (node.status !== "review") throw new Error("Worker has no result awaiting review");
      if (!["accept", "reject", "request-changes"].includes(decision)) throw new Error("Invalid review decision");
      node.status = decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "running";
      node.handoff = { revision: node.handoff?.revision ?? 1,
        status: decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "changes-requested", feedback, submitted: node.handoff?.submitted };
      node.feedback = feedback;
      if (decision === "request-changes") {
        const messageId = randomUUID();
        node.permission = { status: "released", reason: feedback || "Revise the submitted result", source: "parent", updated: new Date().toISOString() };
        delete node.activity;
        const directive = setDirective(run, node, { text: feedback || "Revise the submitted result and resubmit for review.", source: "parent", created: new Date().toISOString(), messageId });
        node.resume = { messageId, revision: node.handoff.revision, status: "queued" };
        node.activity = { status: "instruction-queued", detail: directive.text, updated: directive.created, source: "instruction" };
        run.messages.push({ id: messageId, from: actor, to: child, kind: "instruction", read: false, created: new Date().toISOString(),
          text: feedback || "Revise the submitted result and resubmit for review." });
      }
      return node;
    });
  }
}
