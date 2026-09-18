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
});
