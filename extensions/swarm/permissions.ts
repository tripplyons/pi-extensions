// Holds permit inspection and session housekeeping, not arbitrary execution.
const inspectionTools = new Set([
  "read", "grep", "find", "ls",
  "swarm_task", "swarm_tree", "swarm_models", "swarm_send", "swarm_reload", "swarm_health", "swarm_reviews", "swarm_observe",
  "task_query", "task_output", "task_stop",
  "compress", "search_context", "acp_status", "acp_cache",
]);

export function allowedDuringHold(toolName: string, input?: Record<string, unknown>): boolean {
  // Codemode is a sandboxed dispatcher. Pi sends each nested tool through this gate.
  if (toolName === "codemode") return true;
  if (toolName === "decompress") return input?.toFile === undefined;
  return inspectionTools.has(toolName);
}
