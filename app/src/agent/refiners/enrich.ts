// src/agent/refiners/enrich.ts
//
// Pure derivation helpers used by refine() to fill the DB-only fields that
// skills do not (and should not) compute themselves.

import type { Candidate } from './schema'

/** Compute proposed_budget_brl from current_budget × (1 + change_percent). */
export function deriveProposedBudget(c: Candidate): number | null {
  if (c.current_budget_brl === null || c.change_percent === null) return null
  return Math.round(c.current_budget_brl * (1 + c.change_percent) * 100) / 100
}

/** Compute expected incremental cost and revenue from the proposed budget delta
 *  and the candidate's expected_marginal_roas. */
export function deriveExpectedIncrements(
  c: Candidate,
  proposed: number | null,
): { cost: number | null; revenue: number | null } {
  if (c.current_budget_brl === null || proposed === null) {
    return { cost: null, revenue: null }
  }
  const cost = Math.round((proposed - c.current_budget_brl) * 100) / 100
  const revenue =
    c.expected_marginal_roas !== null
      ? Math.round(cost * c.expected_marginal_roas * 100) / 100
      : null
  return { cost, revenue }
}

/** Compute projected_cos = new_total_cost / new_total_revenue. Null-safe. */
export function deriveProjectedCos(
  c: Candidate,
  expectedRevenue: number | null,
): number | null {
  if (c.current_budget_brl === null || c.change_percent === null) return null
  if (expectedRevenue === null || expectedRevenue === 0) return null
  const newCost = c.current_budget_brl * (1 + c.change_percent)
  return newCost / expectedRevenue
}

/** Compute proposed_target_roas only when the action is to bump tROAS. */
export function deriveProposedTargetRoas(c: Candidate): number | null {
  if (c.recommended_action !== 'increase_troas_or_reduce_budget') return null
  if (c.current_target_roas === null || c.change_percent === null) return null
  return (
    Math.round(c.current_target_roas * (1 + Math.abs(c.change_percent)) * 100) / 100
  )
}
