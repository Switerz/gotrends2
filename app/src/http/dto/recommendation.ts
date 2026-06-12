// src/http/dto/recommendation.ts
//
// HTTP-facing shape for a recommendation. Camel-cased, nested by domain
// (account / campaign / current / proposed / expected / guardrail) so the
// React client can render it without renaming every field.
//
// `accountLabel` is passed in separately because `RecommendationRow` does not
// carry it — the caller (route handler) typically joins or batch-fetches
// labels from `accounts`.

import type { RecommendationRow } from '@/db/types'

export interface RecommendationDTO {
  id: string
  runId: string
  account: { id: string; label: string | null }
  campaign: { id: string; name: string }
  skill: string
  action: string
  changePercent: number | null
  current: {
    budgetBrl: number | null
    targetRoas: number | null
  }
  proposed: {
    budgetBrl: number | null
    targetRoas: number | null
  }
  expected: {
    incrementalCostBrl: number | null
    incrementalRevenueBrl: number | null
    marginalRoas: number | null
    projectedCos: number | null
  }
  confidence: number | null
  risk: string | null
  guardrail: { status: string; reason: string | null }
  reason: string | null
  llmExplanation: string | null
  status: string
  /**
   * Snapshot of cumulative tROAS drift for this campaign at view-time. Only
   * populated by the single-rec GET (`/api/recommendations/:id`) since the
   * list endpoint would otherwise issue N+2 queries. Omitted entirely for
   * non-tROAS actions.
   */
  troasDrift?: {
    todayPct: number
    sevenDayPct: number
    dailyCapPct: number
    sevenDayCapPct: number
  }
  /**
   * Smart Bidding state snapshot at view time. Only populated by the single
   * rec GET when available; absent fields fall through to the SPA as
   * undefined (no badge rendered). See `agent/refiners/biddingLearning.ts`.
   */
  biddingLearning?: {
    status: 'stable' | 'learning' | 'limited' | 'unknown'
    label: string
  }
  /**
   * Latest post-execute verification result, when available. Populated only
   * by the single-rec GET. `null` (or omitted) means no successful execution
   * has been verified yet — either it's still inside the 2h absorption
   * window, or no execution exists at all.
   */
  verification?: {
    status: 'match' | 'drifted' | 'reverted' | 'unavailable'
    observedValue: number | null
    verifiedAt: string
  } | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export function toRecommendationDTO(
  row: RecommendationRow,
  accountLabel?: string | null,
): RecommendationDTO {
  return {
    id: row.recommendation_id,
    runId: row.run_id,
    account: { id: row.account_id, label: accountLabel ?? null },
    campaign: { id: row.campaign_id, name: row.campaign_name },
    skill: row.skill_type,
    action: row.recommended_action,
    changePercent: row.change_percent,
    current: {
      budgetBrl: row.current_budget_brl,
      targetRoas: row.current_target_roas,
    },
    proposed: {
      budgetBrl: row.proposed_budget_brl,
      targetRoas: row.proposed_target_roas,
    },
    expected: {
      incrementalCostBrl: row.expected_incremental_cost_brl,
      incrementalRevenueBrl: row.expected_incremental_revenue_brl,
      marginalRoas: row.expected_marginal_roas,
      projectedCos: row.projected_cos,
    },
    confidence: row.confidence_score,
    risk: row.risk_level,
    guardrail: { status: row.guardrail_status, reason: row.guardrail_reason },
    reason: row.reason,
    llmExplanation: row.llm_explanation,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
