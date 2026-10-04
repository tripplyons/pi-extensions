// Holds permit inspection and session housekeeping, not arbitrary execution.
const inspectionTools = new Set([
  "read", "grep", "find", "ls",
  "swarm_task", "swarm_tree", "swarm_models", "swarm_send", "swarm_board", "swarm_reload", "swarm_health", "swarm_reviews", "swarm_observe",
  "task_query", "task_output", "task_stop", "task_watch",
  "compress", "search_context", "acp_status", "acp_cache", "todo_write", "complain",
]);
export const holdAllowance = "read, grep, find, ls, read-only Bash (one simple command such as git status, git log, git diff, date, ls or uptime; no redirection, chaining or background), swarm inspection and messages, swarm_board, task_query, task_output, task_stop, task_watch, todo_write, complain, compress, search_context, acp_status, acp_cache, and decompress without toFile";

// Commands that only read state. Each entry rejects options that write files or run other programs.
const readOnlyCommands: Record<string, (args: string[]) => boolean> = {
  date: args => !args.some(arg => /^(-[a-zA-Z]*s|--set)/.test(arg)),
  pwd: () => true, whoami: () => true, uptime: () => true, free: () => true, nproc: () => true, uname: () => true, ps: () => true,
  ls: () => true, cat: () => true, head: () => true, wc: () => true, stat: () => true, du: () => true, df: () => true,
  realpath: () => true, readlink: () => true, basename: () => true, dirname: () => true, which: () => true, echo: () => true,
  cut: () => true, diff: () => true, cmp: () => true, sha256sum: () => true, md5sum: () => true, jq: () => true, grep: () => true,
  tail: args => !args.some(arg => /^(-[a-zA-Z]*[fF]|--follow)/.test(arg)),
  sort: args => !args.some(arg => /^(-[a-zA-Z]*o|--output|--compress-program)/.test(arg)),
  rg: args => !args.some(arg => /^(--pre|--search-zip|-z$)/.test(arg)),
  find: args => !args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg)),
  git: ([subcommand, ...args]) => {
    if (args.some(arg => /^(--output|--ext-diff|-O|--open-files-in-pager|--exec)/.test(arg))) return false;
    if (["status", "log", "diff", "show", "rev-parse", "merge-base", "ls-files", "ls-tree", "describe", "blame", "rev-list", "cat-file", "shortlog"].includes(subcommand)) return true;
    if (subcommand === "branch") return args.every(arg => ["--show-current", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv"].includes(arg));
    return (subcommand === "worktree" || subcommand === "stash") && args.length === 1 && args[0] === "list";
  },
};
export function readOnlyBash(command: unknown) {
  if (typeof command !== "string" || !command.trim() || /[;&<>`$(){}\n\r\\]|\|\|/.test(command)) return false;
  const stages = command.split("|");
  return stages.every(stage => {
    const pattern = /'[^']*'|"[^"]*"|[^\s'"]+/g, tokens = stage.match(pattern) ?? [];
    if (stage.replace(pattern, "").trim()) return false;
    const [name, ...args] = tokens.map(token => token.replace(/^(['"])(.*)\1$/, "$2"));
    return Object.hasOwn(readOnlyCommands, name) && readOnlyCommands[name](args);
  });
}

// A permission wait still allows a handoff because it ends work; a reload checkpoint hold does not.
export function allowedDuringHold(toolName: string, input?: Record<string, unknown>, hold: "checkpoint" | "wait" = "checkpoint"): boolean {
  // Codemode is a sandboxed dispatcher. Pi sends each nested tool through this gate.
  if (toolName === "codemode") return true;
  if (toolName === "decompress") return input?.toFile === undefined;
  if (toolName === "bash") return input?.run_in_background !== true && readOnlyBash(input?.command);
  if (toolName === "swarm_complete") return hold === "wait";
  return inspectionTools.has(toolName);
}
