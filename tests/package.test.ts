import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import manifest from "../package.json";

test("Pi SDK development dependencies and minimum host versions stay aligned", () => {
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const) {
    expect(manifest.devDependencies[name]).toBe("1.4.0");
    expect(manifest.peerDependencies[name]).toBe(">=1.4.0");
    expect(manifest.peerDependenciesMeta[name].optional).toBe(true);
  }
});

test("Pi loads every manifest entry without extension errors or duplicate tools", async () => {
  const paths = manifest.pi.extensions.map(path => resolve(import.meta.dir, "..", path));
  const loaded = await loadExtensions(paths, resolve(import.meta.dir, ".."));
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(paths.length);
  // The separate Overseer integration owns the glow, not this package.
  expect(manifest.pi.extensions).not.toContain("./extensions/overseer/index.ts");
  const names = loaded.extensions.flatMap(extension => [...extension.tools.keys()]);
  expect(new Set(names).size).toBe(names.length);
  for (const name of ["glob", "archive_read"]) expect(names).not.toContain(name);
  // Action Fusion re-registers edit and write; the other file tools stay native.
  for (const name of ["read", "grep", "find", "ls"]) expect(names).not.toContain(name);
  const presentation = loaded.extensions.find(extension => extension.path.endsWith("/presentation/index.ts"));
  expect(presentation?.toolRenderers).toHaveLength(1);
  for (const name of ["web_search", "web_extract", "bash", "python", "edit", "write", "obs_recall", "update_plan", "complain", "create_goal", "swarm_task", "swarm_inspect", "session_search", "session_read"])
    expect(names).toContain(name);
  for (const name of ["shell", "bg_process", "sleep", "list", "search", "view_image", "pruned_read", "compress", "decompress", "search_context", "context_status"])
    expect(names).not.toContain(name);
  for (const name of ["btw", "goal", "presentation", "complain", "swarm", "session-search", "council", "python", "lm-studio", "action-fusion", "observation-pack", "evidence-preserving-reducer", "online-context-compact"])
    expect(manifest.pi.extensions).toContain(`./extensions/${name}/index.ts`);
});
