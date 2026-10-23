import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Announces folds and restores so cost models can account for the prompt cache rewrite. */
export const FOLD_EVENT = "pi:context-fold";

export type FoldEvent = {
  phase: "folded" | "restored";
  fold: string;
  /** Tokens each later request saves; negative when a fold is restored. */
  savedTokens: number;
  /** Tokens from the first changed entry to the end of context, rewritten into the cache. */
  rewriteTokens: number;
  ctx: ExtensionContext;
};
