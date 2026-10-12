import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const temporary = new Map<string, string>();

// Files beside the session survive resume and stay out of the repository.
// In-memory sessions get one private temporary directory per process.
export function sessionStorage(ctx: ExtensionContext, name: string): string {
  const id = ctx.sessionManager.getSessionId();
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new Error(`Unsafe session id: ${id}`);
  const dir = ctx.sessionManager.getSessionDir();
  if (dir) return join(dir, name, id);
  const key = `${name}\0${id}`;
  let root = temporary.get(key);
  if (!root) temporary.set(key, root = mkdtempSync(join(tmpdir(), `pi-${name}-${id}-`)));
  return root;
}
