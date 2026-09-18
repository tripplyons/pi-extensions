import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restore } from "./common.ts";

export const minimaxKey = "rework:minimax";
export function minimaxEnabled(ctx: ExtensionContext) {
  return restore<{ enabled: boolean }>(ctx, minimaxKey)?.enabled === true;
}
