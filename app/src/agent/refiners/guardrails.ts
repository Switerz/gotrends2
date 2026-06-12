// src/agent/refiners/guardrails.ts
//
// Business guardrails applied during refine(). The rule order matters: hard
// blocks (e.g. >50% change) take priority over softer review verdicts.

import {
  CONFIDENCE_REVIEW_THRESHOLD,
  MAX_ABS_CHANGE_PERCENT,
  MAX_DAILY_TROAS_DRIFT,
  MAX_TROAS_DRIFT_7D,
} from '@/core/constants'
import type { GuardrailStatus } from '@/core/types'
import type { Candidate } from './schema'
import type { TroasDrift } from './troasDrift'

export interface GuardrailVerdict {
  status: GuardrailStatus
  reason: string | null
}

/** Severity ordering used to merge multiple verdicts. */
const SEVERITY: Record<GuardrailStatus, number> = {
  ok: 0,
  needs_human_review: 1,
  blocked: 2,
}

/** Merge two verdicts; the more severe one wins. Ties prefer the first arg. */
export function mergeVerdicts(
  a: GuardrailVerdict,
  b: GuardrailVerdict | null,
): GuardrailVerdict {
  if (b === null) return a
  return SEVERITY[b.status] > SEVERITY[a.status] ? b : a
}

/** Apply business guardrails to a candidate. Rule order matters:
 *  1. Hard limit on change_percent — blocked
 *  2. Low confidence — needs_human_review
 *  3. Critical anomaly flag (roas/cost) — needs_human_review
 *  4. High risk — needs_human_review
 *  5. Otherwise ok
 *
 *  Hard block takes priority over softer review verdicts.
 */
export function applyGuardrails(c: Candidate): GuardrailVerdict {
  // Rule 1: hard block on excessive change
  if (
    c.change_percent !== null &&
    Math.abs(c.change_percent) > MAX_ABS_CHANGE_PERCENT
  ) {
    return { status: 'blocked', reason: 'change_above_50pct_hard_limit' }
  }

  // Rule 2: low confidence
  if (
    c.confidence_score !== null &&
    c.confidence_score < CONFIDENCE_REVIEW_THRESHOLD
  ) {
    return { status: 'needs_human_review', reason: 'confidence_below_threshold' }
  }

  // Rule 3: critical anomaly
  const flags = c.anomaly_flags ?? {}
  if (flags.roas_anomaly || flags.cost_anomaly) {
    return { status: 'needs_human_review', reason: 'critical_metric_anomaly' }
  }

  // Rule 4: high risk
  if (c.risk_level === 'high') {
    return { status: 'needs_human_review', reason: 'risk_level_high' }
  }

  return { status: 'ok', reason: null }
}

/**
 * Apply the cumulative tROAS drift caps. Returns `null` for any candidate
 * that is not a tROAS mutate (or lacks the tROAS values needed to compute
 * the delta) so the merge step can fall back to the base verdict.
 *
 * The proposed delta is added to the historical sum before checking. The
 * verdict, when issued, is `needs_human_review` (soft cap): a human can
 * still approve via the Chat card with full context, but the auto-pipeline
 * never bypasses the cap on its own.
 *
 * Reason strings carry the consumed-vs-cap figures so an operator can
 * eyeball the situation without opening logs.
 */
export function applyTroasDriftGuardrails(
  c: Candidate,
  proposedTargetRoas: number | null,
  drift: TroasDrift,
): GuardrailVerdict | null {
  if (c.recommended_action !== 'increase_troas_or_reduce_budget') return null
  if (
    proposedTargetRoas === null ||
    c.current_target_roas === null ||
    c.current_target_roas === 0
  ) {
    return null
  }

  const proposedDelta = Math.abs(
    (proposedTargetRoas - c.current_target_roas) / c.current_target_roas,
  )
  const todayTotal = drift.todayDriftPct + proposedDelta
  const sevenDayTotal = drift.sevenDayDriftPct + proposedDelta
  // 0.20 + 0.10 yields 0.30000000000000004 in IEEE 754 — without a tolerance,
  // a sum that the operator perceives as "exactly at the cap" would trip.
  // 1e-9 is well below the rounding the UI shows (one decimal place).
  const EPS = 1e-9

  // Daily cap is the tighter one — if both trip, surface the daily reason
  // because it's the one operators correct first (the 7d window cools off
  // mechanically as old executions roll out).
  if (todayTotal > MAX_DAILY_TROAS_DRIFT + EPS) {
    return {
      status: 'needs_human_review',
      reason:
        `daily_troas_cap (consumed ${pct(drift.todayDriftPct)}/${pct(MAX_DAILY_TROAS_DRIFT)}, ` +
        `+${pct(proposedDelta)} → ${pct(todayTotal)})`,
    }
  }
  if (sevenDayTotal > MAX_TROAS_DRIFT_7D + EPS) {
    return {
      status: 'needs_human_review',
      reason:
        `rolling_7d_troas_cap (consumed ${pct(drift.sevenDayDriftPct)}/${pct(MAX_TROAS_DRIFT_7D)}, ` +
        `+${pct(proposedDelta)} → ${pct(sevenDayTotal)})`,
    }
  }

  return null
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}
