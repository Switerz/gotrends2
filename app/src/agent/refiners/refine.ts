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
import {
  applyGuardrails,
  applyTroasDriftGuardrails,
  mergeVerdicts,
} from './guardrails'
import {
  CandidateSchema,
  RecommendationSchema,
  type Recommendation,
} from './schema'
import type { TroasDrift } from './troasDrift'

export interface RefineContext {
  /** UUID of the model_run this recommendation belongs to. */
  runId: string
  /** UUID for the recommendation row about to be inserted. */
  recommendationId: string
  /**
   * Pre-computed cumulative tROAS drift for this candidate's campaign. When
   * supplied, refine() applies the daily / 7d soft caps and may downgrade a
   * verdict from `ok` to `needs_human_review`. Omitted in tests that don't
   * need the DB plumbing (the existing guardrails still run).
   */
  troasDrift?: TroasDrift
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
  const baseVerdict = applyGuardrails(c)
  // Soft cap layer: only consulted when a drift snapshot is supplied. Merges
  // with the base verdict, taking the more severe of the two.
  const driftVerdict = ctx.troasDrift
    ? applyTroasDriftGuardrails(c, proposed_target_roas, ctx.troasDrift)
    : null
  const verdict = mergeVerdicts(baseVerdict, driftVerdict)

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
    // Normalise undefined → null so the DB row shape never carries a
    // missing-field hole that callers would have to defend against.
    budget_resource_name: c.budget_resource_name ?? null,
    status: 'pending',
    expires_at: null,
  }

  const finalCheck = RecommendationSchema.safeParse(candidate)
  if (!finalCheck.success) {
    throw new RecommendationSchemaViolation(finalCheck.error.toString())
  }
  return finalCheck.data
}
