// src/agent/tools/persistDecision.ts
//
// Atomic tool: refine a Skill-emitted Candidate and persist it as a row in the
// `recommendations` table.
//
// CONTRACT (see plan task 2.10c — Refiner):
//   THIS IS THE ONLY APPROVED ENTRY POINT for inserting recommendations.
//   refine() validates, enriches, applies guardrails, and validates again. A
//   call that bypasses this and goes straight to RecommendationsRepo.insert()
//   violates the integrity contract documented in docs/ARCHITECTURE.md.

import type { GodeployDB } from '@/db/bootstrap'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { refine, type RefineContext } from '@/agent/refiners/refine'
import type { RecommendationRow } from '@/db/types'

export type PersistDecisionContext = RefineContext

/** Refine a candidate and write it to the `recommendations` table.
 *
 *  Throws CandidateInvalid if the candidate fails CandidateSchema validation
 *  (skill produced a malformed output) and RecommendationSchemaViolation if
 *  the derived row fails the strict RecommendationSchema.
 */
export async function persistDecision(
  db: GodeployDB,
  rawCandidate: unknown,
  ctx: PersistDecisionContext,
): Promise<void> {
  const recommendation = refine(rawCandidate, ctx)

  // Adapt the Zod-typed Recommendation to the DB row shape. The Recommendation
  // type carries a couple of skill-only fields (saturation_level, anomaly_flags)
  // that the recommendations table does not have a column for, so we drop them
  // here. created_at / updated_at are filled by SQLite defaults.
  const row: Omit<RecommendationRow, 'created_at' | 'updated_at'> = {
    recommendation_id: recommendation.recommendation_id,
    run_id: recommendation.run_id,
    account_id: recommendation.account_id,
    campaign_id: recommendation.campaign_id,
    campaign_name: recommendation.campaign_name,
    skill_type: recommendation.skill_type,
    recommended_action: recommendation.recommended_action,
    change_percent: recommendation.change_percent,
    current_budget_brl: recommendation.current_budget_brl,
    proposed_budget_brl: recommendation.proposed_budget_brl,
    current_target_roas: recommendation.current_target_roas,
    proposed_target_roas: recommendation.proposed_target_roas,
    expected_incremental_cost_brl: recommendation.expected_incremental_cost_brl,
    expected_incremental_revenue_brl: recommendation.expected_incremental_revenue_brl,
    expected_marginal_roas: recommendation.expected_marginal_roas,
    projected_cos: recommendation.projected_cos,
    confidence_score: recommendation.confidence_score,
    risk_level: recommendation.risk_level,
    reason: recommendation.reason,
    guardrail_status: recommendation.guardrail_status,
    guardrail_reason: recommendation.guardrail_reason,
    llm_payload: recommendation.llm_payload,
    llm_explanation: recommendation.llm_explanation,
    status: recommendation.status,
    expires_at: recommendation.expires_at,
  }

  const repo = new RecommendationsRepo(db)
  await repo.insert(row)
}
