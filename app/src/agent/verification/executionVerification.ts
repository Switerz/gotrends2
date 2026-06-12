// src/agent/verification/executionVerification.ts
//
// Post-execute verification: confirm that a mutate we sent to Google Ads
// actually persisted. Two failure modes the API itself cannot tell us about:
//
//   1. Manual rollback — an operator (or another tool) reverted the value
//      via the Google Ads UI after we applied it. The API returned 200; the
//      change just no longer exists.
//   2. Race with a concurrent mutate — another job wrote a different value
//      moments later. Same observable outcome: our intended value isn't
//      what's live.
//
// The verification cron polls each successful execution once, ~2-24h after
// it completed, classifies the discrepancy, and persists the result. From
// that point on, the row is settled.
//
// This module is the *classifier*. The cron route is the orchestrator; the
// repo handles persistence. Splitting them keeps each piece testable in
// isolation: classifier with synthetic numbers, cron with an in-memory DB.

import type { GoogleAdsClient } from '@/clients/googleAds'
import type { ExecutionRow, RecommendationRow, VerificationStatus } from '@/db/types'

/** Tolerance band for "match". Below this delta we consider the value applied. */
const MATCH_TOLERANCE = 0.01 // 1 % drift counts as match (handles rounding)

/** Beyond this delta we treat as `reverted` rather than `drifted`. */
const DRIFT_TOLERANCE = 0.10 // 1–10% drift = drifted; >10% = reverted

export interface VerificationResult {
  status: VerificationStatus
  /** Value observed in Google Ads (tROAS or budget BRL); null if unread. */
  observedValue: number | null
  /** Value we expected to see (`proposed_target_roas` or `proposed_budget_brl`). */
  proposedValue: number | null
}

/**
 * Pull the live state of `rec.campaign_id` from Google Ads and classify it
 * against the rec's proposed value. Failures (network, deleted campaign,
 * missing field) yield `unavailable` so the cron stops retrying the row.
 *
 * Pure: no DB writes. The caller persists the result via
 * `ExecutionsRepo.markVerified`.
 */
export async function verifyExecution(
  ads: GoogleAdsClient,
  loginCustomerId: string,
  _execution: ExecutionRow,
  rec: RecommendationRow,
): Promise<VerificationResult> {
  // Single-campaign GAQL — both the tROAS and budget paths read from the
  // same projection, so one query covers either action.
  const gaql = `
    SELECT campaign.id,
           campaign.maximize_conversion_value.target_roas,
           campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${rec.campaign_id}
  `

  let raw: unknown[]
  try {
    raw = await ads.searchStream(loginCustomerId, gaql)
  } catch {
    return {
      status: 'unavailable',
      observedValue: null,
      proposedValue: pickProposed(rec),
    }
  }
  if (raw.length === 0) {
    return {
      status: 'unavailable',
      observedValue: null,
      proposedValue: pickProposed(rec),
    }
  }

  const row = raw[0] as {
    campaign?: {
      maximizeConversionValue?: { targetRoas?: number | null }
    }
    campaignBudget?: { amountMicros?: string | number }
  }

  if (rec.recommended_action === 'increase_troas_or_reduce_budget') {
    const observed = row.campaign?.maximizeConversionValue?.targetRoas ?? null
    return classify(observed, rec.proposed_target_roas)
  }
  if (
    rec.recommended_action === 'increase_budget' ||
    rec.recommended_action === 'reduce_budget'
  ) {
    const micros = row.campaignBudget?.amountMicros
    const observed =
      micros === undefined || micros === null ? null : Number(micros) / 1_000_000
    return classify(observed, rec.proposed_budget_brl)
  }

  // Non-mutating actions slip through: they shouldn't appear in executions
  // (executor refuses them upstream), but defend anyway.
  return {
    status: 'unavailable',
    observedValue: null,
    proposedValue: null,
  }
}

/** Compare observed vs proposed using the two tolerance bands. */
function classify(
  observed: number | null,
  proposed: number | null,
): VerificationResult {
  if (observed === null) {
    return { status: 'unavailable', observedValue: null, proposedValue: proposed }
  }
  if (proposed === null || proposed === 0) {
    // Without a proposed value we can't compute a percentage drift. Surface
    // the observed value but classify as unavailable so the row is settled
    // without a misleading match/drift verdict.
    return { status: 'unavailable', observedValue: observed, proposedValue: proposed }
  }
  const delta = Math.abs(observed - proposed) / Math.abs(proposed)
  if (delta <= MATCH_TOLERANCE) {
    return { status: 'match', observedValue: observed, proposedValue: proposed }
  }
  if (delta <= DRIFT_TOLERANCE) {
    return { status: 'drifted', observedValue: observed, proposedValue: proposed }
  }
  return { status: 'reverted', observedValue: observed, proposedValue: proposed }
}

function pickProposed(rec: RecommendationRow): number | null {
  if (rec.recommended_action === 'increase_troas_or_reduce_budget') {
    return rec.proposed_target_roas
  }
  if (
    rec.recommended_action === 'increase_budget' ||
    rec.recommended_action === 'reduce_budget'
  ) {
    return rec.proposed_budget_brl
  }
  return null
}
