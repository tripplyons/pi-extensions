import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Capture package source at factory load, not when an old worker reports later.
export function packageRevision(root = join(dirname(fileURLToPath(import.meta.url)), "../..")) {
  const hash = createHash("sha256");
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || !/\.(?:ts|js|json)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      hash.update(relative(root, file)); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0");
    }
  }
  // Direct --extension installs can omit the root manifest. Hash runtime source
  // only so they report the same revision as package installs of that source.
  visit(join(root, "lib")); visit(join(root, "extensions"));
  return hash.digest("hex");
}
