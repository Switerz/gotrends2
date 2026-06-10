// src/agent/refiners/guardrails.ts
//
// Business guardrails applied during refine(). The rule order matters: hard
// blocks (e.g. >50% change) take priority over softer review verdicts.

import { CONFIDENCE_REVIEW_THRESHOLD, MAX_ABS_CHANGE_PERCENT } from '@/core/constants'
import type { GuardrailStatus } from '@/core/types'
import type { Candidate } from './schema'

export interface GuardrailVerdict {
  status: GuardrailStatus
  reason: string | null
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
