// src/agent/refiners/refine.ts
//
// The single integrity gate between Skill candidates and DB Recommendation rows.
//
// CONTRACT (see docs/ARCHITECTURE.md → "agent/refiners/"):
//   refine() is the ONLY approved entry point for inserting into the
//   recommendations table. Skills produce loose Candidates; this function
//   validates, enriches, applies guardrails, and validates the output against
//   the strict RecommendationSchema before returning a DB-ready row. Bypassing
//   it is a violation of the integrity contract.

import { CandidateInvalid, RecommendationSchemaViolation } from '@/core/errors'
import {
  deriveExpectedIncrements,
  deriveProjectedCos,
  deriveProposedBudget,
  deriveProposedTargetRoas,
} from './enrich'
import { applyGuardrails } from './guardrails'
import {
  CandidateSchema,
  RecommendationSchema,
  type Recommendation,
} from './schema'

export interface RefineContext {
  /** UUID of the model_run this recommendation belongs to. */
  runId: string
  /** UUID for the recommendation row about to be inserted. */
  recommendationId: string
}

/** Refine a raw skill candidate into a DB-ready Recommendation.
 *  - Validates input against CandidateSchema (throws CandidateInvalid on fail)
 *  - Derives proposed_budget, proposed_target_roas, expected increments, projected_cos
 *  - Applies guardrails → guardrail_status + guardrail_reason
 *  - Validates output against RecommendationSchema (throws RecommendationSchemaViolation on fail)
 *
 *  THIS IS THE ONLY APPROVED ENTRY POINT for inserting into the recommendations table.
 */
export function refine(rawCandidate: unknown, ctx: RefineContext): Recommendation {
  const parsed = CandidateSchema.safeParse(rawCandidate)
  if (!parsed.success) {
    throw new CandidateInvalid(parsed.error.toString())
  }
  const c = parsed.data

  const proposed_budget_brl = deriveProposedBudget(c)
  const inc = deriveExpectedIncrements(c, proposed_budget_brl)
  const projected_cos = deriveProjectedCos(c, inc.revenue)
  const proposed_target_roas = deriveProposedTargetRoas(c)
  const verdict = applyGuardrails(c)

  const candidate: Recommendation = {
    ...c,
    recommendation_id: ctx.recommendationId,
    run_id: ctx.runId,
    proposed_budget_brl,
    proposed_target_roas,
    expected_incremental_cost_brl: inc.cost,
    expected_incremental_revenue_brl: inc.revenue,
    projected_cos,
    guardrail_status: verdict.status,
    guardrail_reason: verdict.reason,
    llm_payload: null,
    llm_explanation: null,
    status: 'pending',
    expires_at: null,
  }

  const finalCheck = RecommendationSchema.safeParse(candidate)
  if (!finalCheck.success) {
    throw new RecommendationSchemaViolation(finalCheck.error.toString())
  }
  return finalCheck.data
}
