import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import manifest from "../package.json";

test("Pi loads every manifest entry without extension errors or duplicate tools", async () => {
  const paths = manifest.pi.extensions.map(path => resolve(import.meta.dir, "..", path));
  const loaded = await loadExtensions(paths, resolve(import.meta.dir, ".."));
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(paths.length);
  const names = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  expect(new Set(names).size).toBe(names.length);
  for (const name of ["glob", "archive_read"]) expect(names).not.toContain(name);
  for (const name of ["web_search", "web_extract", "read", "edit", "write", "bash", "grep", "find", "ls", "todo_write", "complain", "create_goal", "swarm_task"])
    expect(names).toContain(name);
  for (const name of ["shell", "bg_process", "sleep", "list", "search", "view_image", "pruned_read"])
    expect(names).not.toContain(name);
  for (const name of ["btw", "goal", "presentation", "complain", "swarm"])
    expect(manifest.pi.extensions).toContain(`./extensions/${name}/index.ts`);
});
