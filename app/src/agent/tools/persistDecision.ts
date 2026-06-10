// src/agent/tools/persistDecision.ts
//
// STUB tool: persist a Skill-emitted Candidate as a row in the `recommendations`
// table.
//
// CONTRACT (see plan task 2.10c — Refiner):
//   The implementation MUST call `refine(rawCandidate, ctx)` from
//   `@/agent/refiners` BEFORE inserting. The refiner is responsible for
//   validating the candidate, applying guardrails, computing risk_level,
//   filling llm_payload/llm_explanation, and choosing the canonical
//   recommended_action. Calling persistDecision without going through the
//   refiner would bypass guardrails and risk persisting unreviewed proposals.
//
// This stub throws until the refiner lands; do NOT inline a partial persist
// here — it would create a dangerous regression surface.

import type { GodeployDB } from '@/db/bootstrap'

export interface PersistDecisionContext {
  runId: string
  recommendationId: string
}

export async function persistDecision(
  _db: GodeployDB,
  _rawCandidate: unknown,
  _ctx: PersistDecisionContext,
): Promise<void> {
  throw new Error('not_implemented_until_refiner_lands')
}
