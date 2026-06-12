// src/agent/refiners/biddingLearning.ts
//
// Domain abstraction for the Google Ads Smart Bidding system status.
//
// The raw enum that Google returns (`bidding_strategy_system_status`) has 20+
// values — most of which collapse to a small number of operational categories
// from our perspective:
//
//   stable   → Smart Bidding is calibrated; safe to apply a bid change.
//   learning → algorithm is currently recalibrating (after a config change
//              or campaign creation); a new bid change here resets the
//              learning window and wastes the in-progress signal.
//   limited  → bidding is constrained by another factor (budget exhausted,
//              bid floor/ceiling, low quality, misconfiguration). The bid
//              isn't the bottleneck — changing it doesn't help.
//   unknown  → field missing or contains a value we don't recognise. The
//              guardrail does NOT downgrade on this — missing data must not
//              create false review verdicts on every rec.
//
// Two layers:
//   - `BiddingLearningStatus` is the only thing the rest of the pipeline (and
//     the guardrails) ever reads.
//   - `classifyBiddingLearning` is the single place that knows the raw
//     Google Ads enum strings. When the API surface changes, only this file
//     needs to follow.

export type BiddingLearningStatus = 'stable' | 'learning' | 'limited' | 'unknown'

/** Raw values that map to `learning`. Sourced from Google Ads API v20 docs. */
const LEARNING_RAW: ReadonlySet<string> = new Set([
  'LEARNING_NEW',
  'LEARNING_SETTING_CHANGE',
  'LEARNING_BUDGET_CHANGE',
  'LEARNING_BID_CHANGE',
  'LEARNING_COMPOSITION_CHANGE',
  'LEARNING_CONVERSION_TYPE_CHANGE',
  'LEARNING_CONVERSION_SETTING_CHANGE',
])

/** Raw values that map to `limited`. Includes every `LIMITED_*` and
 *  `MISCONFIGURED_*` variant — both signal "the bid is not the bottleneck". */
const LIMITED_PREFIXES: readonly string[] = ['LIMITED_', 'MISCONFIGURED_']

/**
 * Map a raw `bidding_strategy_system_status` string (or null/undefined) to our
 * domain type. Case-insensitive and tolerant of unknown enum members from
 * future API versions — those fall through to `unknown` so the guardrail
 * never blocks based on data it doesn't recognise.
 */
export function classifyBiddingLearning(
  raw: string | null | undefined,
): BiddingLearningStatus {
  if (raw === null || raw === undefined || raw === '') return 'unknown'
  const v = String(raw).toUpperCase()

  if (v === 'ENABLED') return 'stable'
  if (LEARNING_RAW.has(v)) return 'learning'
  if (LIMITED_PREFIXES.some((p) => v.startsWith(p))) return 'limited'

  // `PAUSED`, `PENDING`, `REMOVED`, `UNAVAILABLE`, and any future value we
  // haven't classified: treat as `unknown`. The guardrail's policy is "don't
  // act on what we don't know" — operators can still approve via Chat, and
  // we don't generate false-positive reviews.
  return 'unknown'
}

/** Human-friendly PT-BR labels for surfacing on the UI. */
export const BIDDING_LEARNING_LABELS: Record<BiddingLearningStatus, string> = {
  stable: 'estável',
  learning: 'em aprendizado',
  limited: 'limitado',
  unknown: 'indisponível',
}
