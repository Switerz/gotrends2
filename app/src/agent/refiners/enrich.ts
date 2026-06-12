// src/agent/refiners/enrich.ts
//
// Pure derivation helpers used by refine() to fill the DB-only fields that
// skills do not (and should not) compute themselves.
//
// IMPORTANT: every derivation here is keyed on `recommended_action` so the
// projected values are coherent with what the executor will actually mutate.
// A previous bug applied `change_percent` directly to the budget for ALL
// actions, including `increase_troas_or_reduce_budget` — that surfaced as
// "Budget 1000 → 1100" on a card whose mutate path only touches tROAS,
// confusing operators. The action ↔ field mapping below is the canonical
// truth; the executor's branches (`execute.ts`) mirror it.

import type { Candidate } from './schema'

/**
 * Compute `proposed_budget_brl` per action semantics:
 *
 *   increase_budget                → current × (1 + |change|)   (executor mutates budget)
 *   reduce_budget                  → current × (1 − |change|)   (executor mutates budget)
 *   increase_troas_or_reduce_budget → current (UNCHANGED)         (executor mutates tROAS only)
 *   anything else                  → null                         (non-mutating actions)
 *
 * The skill's `change_percent` is treated as a magnitude — we apply the sign
 * that matches the action. Defends against a skill emitting +0.10 for a
 * reduce_budget action.
 */
export function deriveProposedBudget(c: Candidate): number | null {
  if (c.current_budget_brl === null || c.change_percent === null) return null
  const mag = Math.abs(c.change_percent)
  switch (c.recommended_action) {
    case 'increase_budget':
      return round2(c.current_budget_brl * (1 + mag))
    case 'reduce_budget':
      return round2(c.current_budget_brl * (1 - mag))
    case 'increase_troas_or_reduce_budget':
      // tROAS action — budget stays put. The executor never touches the
      // budget for this action; returning current keeps the card / DTO
      // honest (no fake "+10%" arrow on the budget pair).
      return round2(c.current_budget_brl)
    default:
      return null
  }
}

/**
 * Expected incremental cost / revenue.
 *
 * For budget-mutating actions: cost delta = proposed − current (signed),
 * revenue delta = cost × expected_marginal_roas (skill-supplied).
 *
 * For `increase_troas_or_reduce_budget`: the budget is NOT moving, so the
 * incremental cost is exactly 0. Revenue is also 0 — second-order effects
 * of tROAS changes (volume drift) are out of scope for this derivation and
 * belong to a future tROAS-aware elasticity model. Better to show 0 than a
 * fake non-zero figure derived from a budget delta that won't happen.
 */
export function deriveExpectedIncrements(
  c: Candidate,
  proposed: number | null,
): { cost: number | null; revenue: number | null } {
  if (c.current_budget_brl === null || proposed === null) {
    return { cost: null, revenue: null }
  }
  if (c.recommended_action === 'increase_troas_or_reduce_budget') {
    return { cost: 0, revenue: 0 }
  }
  const cost = round2(proposed - c.current_budget_brl)
  const revenue =
    c.expected_marginal_roas !== null
      ? round2(cost * c.expected_marginal_roas)
      : null
  return { cost, revenue }
}

/**
 * Projected COS = new_total_cost / new_total_revenue. Null-safe.
 *
 * For `increase_troas_or_reduce_budget` the budget — and therefore total
 * cost — does not move, so the COS projection collapses to current/expected.
 * For budget actions, new_cost = current × (1 + signed change).
 */
export function deriveProjectedCos(
  c: Candidate,
  expectedRevenue: number | null,
): number | null {
  if (c.current_budget_brl === null || c.change_percent === null) return null
  if (expectedRevenue === null || expectedRevenue === 0) return null
  const mag = Math.abs(c.change_percent)
  let newCost: number
  switch (c.recommended_action) {
    case 'increase_budget':
      newCost = c.current_budget_brl * (1 + mag)
      break
    case 'reduce_budget':
      newCost = c.current_budget_brl * (1 - mag)
      break
    case 'increase_troas_or_reduce_budget':
      newCost = c.current_budget_brl
      break
    default:
      return null
  }
  return newCost / expectedRevenue
}

/** Compute proposed_target_roas only when the action is to bump tROAS. */
export function deriveProposedTargetRoas(c: Candidate): number | null {
  if (c.recommended_action !== 'increase_troas_or_reduce_budget') return null
  if (c.current_target_roas === null || c.change_percent === null) return null
  return round2(c.current_target_roas * (1 + Math.abs(c.change_percent)))
}

/** Round to 2 decimals — money / ratio convention used across the refiner. */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}
