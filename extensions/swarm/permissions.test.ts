import { expect, test } from "bun:test";
import { allowedDuringHold, readOnlyBash } from "./permissions.ts";

test("holds allow single read-only commands and reject writes, chaining and execution", () => {
  for (const command of ["date", "git status --short", "git log --oneline -5", "git diff HEAD~1 -- src", "ls -la 'a b'", "uptime", "git branch --show-current", "rg -n foo src | head -20", "cat notes.md | wc -l"]) expect(readOnlyBash(command)).toBe(true);
  for (const command of ["", "date -s 2020-01-01", "date -us 2020-01-01", "git checkout main", "git diff --output=x", "rm -rf x", "ls > out", "date; rm x", "date && ls", "echo $(rm x)", "echo `rm x`", "find . -delete", "find . -exec rm {} +", "tail -f log", "sort -o out in", "git branch new", "ls\nrm x", "cat x | sh", "rg --pre sh foo"]) expect(readOnlyBash(command)).toBe(false);
});

test("waits allow housekeeping tools and handoff; checkpoints refuse the handoff", () => {
  for (const tool of ["todo_write", "complain", "task_watch", "swarm_board"]) for (const hold of ["checkpoint", "wait"] as const) expect(allowedDuringHold(tool, {}, hold)).toBe(true);
  expect(allowedDuringHold("bash", { command: "git status" }, "checkpoint")).toBe(true);
  expect(allowedDuringHold("bash", { command: "git status", run_in_background: true }, "wait")).toBe(false);
  expect(allowedDuringHold("bash", { command: "npm test" }, "wait")).toBe(false);
  expect(allowedDuringHold("swarm_complete", {}, "wait")).toBe(true);
  expect(allowedDuringHold("swarm_complete", {}, "checkpoint")).toBe(false);
  expect(allowedDuringHold("edit", {}, "wait")).toBe(false);
});
