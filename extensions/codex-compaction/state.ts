import { createHash } from "node:crypto";
import type { Item } from "./protocol.ts";

type Binding = { session: string; provider: string; model: string };
export type SavedCheckpoint = Binding & {
  version: 1;
  prefixLength: number;
  protectedCallIds?: string[];
  prefixHash: string;
  replacement: Item[];
};

// Object insertion order is irrelevant; array order is conversation order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const digest = (input: Item[]) => createHash("sha256").update(canonical(input)).digest("hex");

export function saveCheckpoint(binding: Binding, input: Item[], replacement: Item[]): SavedCheckpoint {
  if (!binding.session || !binding.model || binding.provider !== "openai-codex") throw new Error("Invalid Codex checkpoint binding");
  if (!input.length) throw new Error("Cannot checkpoint empty conversation");
  const last = replacement.at(-1);
  if (last?.type !== "compaction" || typeof last.encrypted_content !== "string" || !last.encrypted_content ||
    replacement.slice(0, -1).some(item => item.role !== "user")) throw new Error("Invalid checkpoint replacement");
  return { ...binding, version: 1, protectedCallIds: input.flatMap(item => typeof item.call_id === "string" ? [item.call_id] : []), prefixLength: input.length, prefixHash: digest(input), replacement: structuredClone(replacement) };
}

export function projectCheckpoint(binding: Binding, input: Item[], saved: SavedCheckpoint | undefined): Item[] {
  if (!saved || saved.version !== 1 || saved.session !== binding.session || saved.provider !== binding.provider || saved.model !== binding.model) return input;
  if (!Number.isInteger(saved.prefixLength) || saved.prefixLength < 1 || saved.prefixLength > input.length) return input;
  if (digest(input.slice(0, saved.prefixLength)) !== saved.prefixHash) return input;
  return [...structuredClone(saved.replacement), ...input.slice(saved.prefixLength)];
}
