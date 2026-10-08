import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { formatHistory, historyNotice, historyPage, readHistory, type HistoryRequest } from "../../lib/session-history.ts";
import { viewHistory } from "../../lib/history-viewer.ts";
import { currentAssignment, handoffRecord, type Node, type Run } from "./state.ts";

function bounded(text: string | undefined, max = 8000) {
  return text === undefined ? null : { text: text.slice(0, max), length: text.length, truncated: text.length > max };
}

export async function inspectWorker(run: Run, nodeId: string, options: HistoryRequest = {}, signal?: AbortSignal) {
  if (!Object.hasOwn(run.nodes, nodeId)) throw new Error("Unknown node in this swarm run; use swarm_tree to find node IDs");
  const node = run.nodes[nodeId];
  if (!node.parent) throw new Error("Worker inspection requires a worker node, not the root session");
  signal?.throwIfAborted();
  let conversation = null, conversationError: string | null = null;
  if (node.session) {
    let history;
    try { history = await readHistory(node.session, signal); }
    catch (error) { signal?.throwIfAborted(); conversationError = String(error); }
    // Invalid pagination is a caller error, not an unavailable transcript.
    if (history) conversation = historyPage(history, options);
  } else conversationError = "Worker has not saved a session yet.";
  const assignment = currentAssignment(node);
  return { notice: historyNotice, nodeId: node.id, name: node.name, parent: node.parent, status: node.status,
    permission: node.permission ? { ...node.permission, reason: bounded(node.permission.reason) } : null, activity: node.activity ? { ...node.activity, detail: bounded(node.activity.detail) } : null,
    model: node.current ?? node.launch ?? null, branch: node.branch ?? null, cwd: node.worktree?.cwd ?? null,
    sessionPath: node.session ?? null, assignment: assignment ? { ...assignment, text: bounded(assignment.text) } : null,
    handoff: node.result ? { ...handoffRecord(node), result: bounded(node.result, 12000), feedback: bounded(node.feedback) } : null,
    delivery: (node.delivery ?? []).slice(-20).map(record => ({ ...record,
      ...Object.fromEntries(["reviewed", "tested", "integrated"].filter(stage => record[stage as "reviewed"])
        .map(stage => { const evidence = record[stage as "reviewed"]!; return [stage, { ...evidence, text: evidence.text.slice(0, 1000), textLength: evidence.text.length, truncated: evidence.text.length > 1000 }]; })),
    })), omittedDelivery: Math.max(0, (node.delivery?.length ?? 0) - 20),
    conversation, conversationError };
}

function overview(snapshot: Awaited<ReturnType<typeof inspectWorker>>) {
  return [snapshot.notice, `${snapshot.name} (${snapshot.nodeId}) | ${snapshot.status}`,
    `Parent: ${snapshot.parent}\nPermission: ${snapshot.permission?.status ?? "unknown"}\nBranch: ${snapshot.branch ?? "none"}\nWorkspace: ${snapshot.cwd ?? "none"}\nSession: ${snapshot.sessionPath ?? "not saved"}`,
    `Model: ${JSON.stringify(snapshot.model)}\nActivity: ${snapshot.activity?.status ?? "unknown"}\n${snapshot.activity?.detail?.text ?? ""}`,
    snapshot.assignment ? `Current assignment (generation ${snapshot.assignment.generation}):\n${snapshot.assignment.text?.text}${snapshot.assignment.text?.truncated ? "\n[Assignment truncated; use swarm_task or swarm_tree for the full record.]" : ""}` : "No current assignment. A historical handoff does not authorize more work.",
    `Handoff: ${snapshot.handoff?.status ?? "none"}\nCode evidence is independent of handoff acceptance.`,
    snapshot.conversationError ? `Conversation unavailable: ${snapshot.conversationError}` : "Saved conversation available."].join("\n\n");
}

export async function workerInspector(ctx: ExtensionContext, readRun: () => Promise<Run>, terminalOutput: (node: Node) => Promise<string>, requested?: string) {
  if (ctx.mode !== "tui") { ctx.ui.notify("Use swarm_inspect for saved conversation history and swarm_observe for terminal output in other modes.", "warning"); return; }
  let nodeId = requested?.trim();
  if (!nodeId) {
    const nodes = Object.values((await readRun()).nodes).filter(node => node.parent);
    if (!nodes.length) { ctx.ui.notify("No workers to inspect.", "info"); return; }
    const choices = nodes.map(node => stripTerminalSequences(`${node.name} | ${node.status} | ${node.id}`));
    const choice = await ctx.ui.select("Inspect worker (including retained workers)", choices);
    if (choice === undefined) return;
    nodeId = nodes[choices.indexOf(choice)]?.id;
    if (!nodeId) return;
  }
  while (true) {
    const run = await readRun();
    const snapshot = await inspectWorker(run, nodeId);
    const choice = await ctx.ui.select(`Inspect ${stripTerminalSequences(snapshot.name)}`, ["Overview", "Conversation", "Handoff and code evidence", "Terminal output"]);
    if (choice === undefined) return;
    let request: HistoryRequest = {};
    while (true) {
      const freshRun = await readRun(), fresh = await inspectWorker(freshRun, nodeId, request);
      let body: string;
      if (choice === "Conversation") body = fresh.conversation ? formatHistory(fresh.conversation) : fresh.conversationError!;
      else if (choice === "Handoff and code evidence") body = [fresh.notice,
        fresh.handoff ? `Handoff revision ${fresh.handoff.revision}, ${fresh.handoff.status}\n${fresh.handoff.result?.text}${fresh.handoff.result?.truncated ? "\n[Handoff truncated; use swarm_reviews or swarm_tree for the full record.]" : ""}\n\nFeedback: ${fresh.handoff.feedback?.text ?? "none"}` : "No handoff submitted.",
        `Code evidence (parent-reported, separate from acceptance):\n${JSON.stringify(fresh.delivery, null, 2)}`].join("\n\n");
      else if (choice === "Terminal output") {
        try { body = await terminalOutput(freshRun.nodes[nodeId]); }
        catch (error) { body = `Terminal output unavailable: ${String(error)}\nSaved conversation and handoff inspection do not need a live pane.`; }
      } else body = overview(fresh);
      const record = fresh.conversation?.records.find(item => item.entryId === request.entryId);
      const conversation = choice === "Conversation";
      const action = await viewHistory(ctx, `${fresh.name} | ${choice}`, body, {
        older: conversation && Boolean(fresh.conversation?.nextBeforeEntryId), entry: conversation && Boolean(fresh.conversation?.records.length),
        expand: conversation && Boolean(record?.summary) && !request.expandSummary,
        more: conversation && !request.expandSummary && record?.nextTextOffset != null,
      });
      if (action === "close") break;
      if (action === "older") request = { ...request, beforeEntryId: fresh.conversation!.nextBeforeEntryId!, textOffset: undefined };
      if (action === "expand") request = { entryId: request.entryId, expandSummary: true };
      if (action === "more") request = { entryId: request.entryId, textOffset: record!.nextTextOffset!, limit: 1 };
      if (action === "entry") {
        const records = fresh.conversation!.records;
        const choices = records.map(item => stripTerminalSequences(`${item.entryId} | ${item.kind} | ${item.text.slice(0, 100).replace(/\s+/g, " ")}`));
        const selected = await ctx.ui.select("Open conversation entry", choices);
        const entry = selected === undefined ? undefined : records[choices.indexOf(selected)];
        if (entry) request = { entryId: entry.entryId };
      }
    }
  }
}
