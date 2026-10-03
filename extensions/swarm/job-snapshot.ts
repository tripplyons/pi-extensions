import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Node } from "./state.ts";
import type { Jobs } from "./jobs.ts";
import type { OwnedJob } from "./coordination.ts";
import { taskKey } from "../tasks/tasks.ts";

// Read metadata only. Tasks.query would incorrectly mark another runtime's jobs lost.
export async function ownedJobs(root: string, jobs: Jobs, node: Node): Promise<OwnedJob[]> {
  if (!node.session) throw new Error("Worker session is not available; job ownership is unknown");
  const entries = (await readFile(node.session, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") throw new Error("Invalid worker session header");
  const snapshot: OwnedJob[] = (await jobs.list(header.id)).map(job => ({ id: job.id, status: job.status, source: "tmux" }));
  // Include abandoned branches conservatively: their processes may still be alive.
  const ids = new Set(entries.filter(entry => entry.type === "custom" && entry.customType === taskKey).map(entry => entry.data));
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid worker task ID");
    const record = JSON.parse(await readFile(join(root, "minimax", "tasks", `${id}.json`), "utf8"));
    if (record.task_id !== id || typeof record.status !== "string") throw new Error("Invalid worker task record");
    snapshot.push({ id, status: record.status, source: "bash" });
  }
  return snapshot;
}
