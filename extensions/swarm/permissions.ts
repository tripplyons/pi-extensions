// Holds permit inspection and session housekeeping, not arbitrary execution.
const inspectionTools = new Set([
  "read", "grep", "find", "ls",
  "swarm_task", "swarm_tree", "swarm_models", "swarm_send", "swarm_board", "swarm_reload", "swarm_health", "swarm_reviews", "swarm_observe",
  "task_query", "task_output", "task_stop",
  "compress", "search_context", "acp_status", "acp_cache",
]);

// A permission wait still allows a handoff because it ends work; a reload checkpoint hold does not.
export function allowedDuringHold(toolName: string, input?: Record<string, unknown>, hold: "checkpoint" | "wait" = "checkpoint"): boolean {
  // Codemode is a sandboxed dispatcher. Pi sends each nested tool through this gate.
  if (toolName === "codemode") return true;
  if (toolName === "decompress") return input?.toFile === undefined;
  if (toolName === "swarm_complete") return hold === "wait";
  return inspectionTools.has(toolName);
}
