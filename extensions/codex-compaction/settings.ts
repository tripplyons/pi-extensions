import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restore } from "../../lib/common.ts";

export const compactionKey = "rework:codex-compaction";
export const defaultThreshold = 60_000;

export function compactionThreshold(ctx: ExtensionContext): number {
  return restore<{ threshold: number }>(ctx, compactionKey)?.threshold ?? defaultThreshold;
}
