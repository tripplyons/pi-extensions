/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted from SoL-Pi Online Context Compact: https://github.com/NVlabs/SoL-Pi
 */

// Writing a cached prompt costs this many times more than reading it.
export const CACHE_WRITE_READ_RATIO = 12.5;
const WINDOW_RESERVE_TOKENS = 16_384;
// The first compaction has no payback history, so it may count on a longer horizon.
const FIRST_HORIZON_SCALE = 2;
const LATER_MARGIN = 1.5;
const COOLDOWN_REQUESTS = 2;

export type CompactionInput = {
  /** Tokens the next request writes without compaction. */
  contextTokens: number;
  /** Tokens compaction would remove. */
  archiveTokens: number;
  /** Tokens of the summary that replaces them. */
  summaryTokens: number;
  /** Provider requests between earlier completed plan steps. */
  requestsPerStep: number[];
  remainingSteps: number;
  averageGrowth: number | null;
  contextWindow: number | null;
  priorCompactions: number;
  requestsSinceCompaction: number | null;
  carriedDebt: number;
  debtRepayment: number;
};

export type CompactionDecision = {
  compact: boolean;
  reason: "window_protection" | "economic" | "cooldown" | "uneconomic" | "no_saving";
  /** Extra cost of rewriting the compacted prompt into the cache, in read-token units. */
  debt: number;
  /** Read tokens each later request saves. */
  saving: number;
};

// Compact when the cache rewrite pays for itself before the plan is expected to end.
export function decideCompaction(input: CompactionInput): CompactionDecision {
  const saving = input.archiveTokens - input.summaryTokens;
  const debt = Math.max(0, input.contextTokens - saving) * (CACHE_WRITE_READ_RATIO - 1);
  const decision = (compact: boolean, reason: CompactionDecision["reason"]) => ({ compact, reason, debt, saving });
  if (saving <= 0) return decision(false, "no_saving");
  if (input.contextWindow !== null && input.contextTokens >= input.contextWindow - WINDOW_RESERVE_TOKENS) {
    return decision(true, "window_protection");
  }

  const counts = input.requestsPerStep;
  const mean = counts.reduce((total, count) => total + count, 0) / Math.max(1, counts.length);
  const windowLimit = input.contextWindow !== null && input.averageGrowth !== null && input.averageGrowth > 0
    ? Math.max(0, Math.floor((input.contextWindow - input.contextTokens) / input.averageGrowth))
    : Infinity;
  const remaining = Math.min(1 + Math.floor(mean * input.remainingSteps), windowLimit);
  const breakeven = debt / saving;
  const economic = remaining > 0 && (input.priorCompactions === 0
    ? breakeven <= Math.min(remaining * FIRST_HORIZON_SCALE, windowLimit)
    : breakeven * LATER_MARGIN <= remaining
      && (input.carriedDebt + debt) / (input.debtRepayment + saving) <= remaining);
  if (!economic) return decision(false, "uneconomic");
  if (input.requestsSinceCompaction !== null && input.requestsSinceCompaction < COOLDOWN_REQUESTS) return decision(false, "cooldown");
  return decision(true, "economic");
}
