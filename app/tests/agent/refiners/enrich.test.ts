// tests/agent/refiners/enrich.test.ts
//
// Action-aware enrichment derivations. The previous bug applied a budget
// delta on every action, including tROAS-only mutates — these tests pin
// the action ↔ field mapping.

import { describe, it, expect } from 'vitest'
import {
  deriveProposedBudget,
  deriveExpectedIncrements,
  deriveProjectedCos,
  deriveProposedTargetRoas,
} from '@/agent/refiners/enrich'
import type { Candidate } from '@/agent/refiners/schema'

function base(over: Partial<Candidate> = {}): Candidate {
  return {
    account_id: '7705857660',
    campaign_id: 'camp-1',
    campaign_name: 'NB',
    skill_type: 'budget_reallocation',
    recommended_action: 'increase_budget',
    change_percent: 0.10,
    current_budget_brl: 1000,
    current_target_roas: 5.0,
    expected_marginal_roas: 3.5,
    confidence_score: 80,
    risk_level: 'low',
    reason: null,
    ...over,
  }
}

describe('deriveProposedBudget', () => {
  it('increase_budget: applies positive delta (current × (1 + |change|))', () => {
    expect(deriveProposedBudget(base({ recommended_action: 'increase_budget' }))).toBe(1100)
  })

  it('reduce_budget: applies negative delta (current × (1 − |change|))', () => {
    expect(deriveProposedBudget(base({ recommended_action: 'reduce_budget' }))).toBe(900)
  })

  it('reduce_budget: forces the sign even when skill sends positive change_percent (defensive)', () => {
    // Skill might send +0.10 with a reduce_budget action; we still reduce.
    expect(deriveProposedBudget(base({ recommended_action: 'reduce_budget', change_percent: 0.10 }))).toBe(900)
  })

  it('increase_troas_or_reduce_budget: budget UNCHANGED (executor mutates tROAS only)', () => {
    // This is the bug we just fixed — used to return 1100, surfacing as
    // "Budget 1000 → 1100" on a tROAS-action card.
    const c = base({ recommended_action: 'increase_troas_or_reduce_budget' })
    expect(deriveProposedBudget(c)).toBe(1000)
  })

  it('non-executable actions: returns null (no proposed budget)', () => {
    expect(deriveProposedBudget(base({ recommended_action: 'optimize_efficiency' }))).toBeNull()
    expect(deriveProposedBudget(base({ recommended_action: 'improve_ads_or_terms' }))).toBeNull()
    expect(deriveProposedBudget(base({ recommended_action: 'review_landing_or_offer' }))).toBeNull()
  })

  it('null current_budget or null change_percent: returns null', () => {
    expect(deriveProposedBudget(base({ current_budget_brl: null }))).toBeNull()
    expect(deriveProposedBudget(base({ change_percent: null }))).toBeNull()
  })
})

describe('deriveExpectedIncrements', () => {
  it('increase_budget: cost = +delta, revenue = cost × marginal_roas', () => {
    const c = base({ recommended_action: 'increase_budget' })
    expect(deriveExpectedIncrements(c, 1100)).toEqual({ cost: 100, revenue: 350 })
  })

  it('reduce_budget: cost = −delta, revenue = cost × marginal_roas (also negative)', () => {
    const c = base({ recommended_action: 'reduce_budget' })
    expect(deriveExpectedIncrements(c, 900)).toEqual({ cost: -100, revenue: -350 })
  })

  it('increase_troas_or_reduce_budget: cost = 0 and revenue = 0 (budget unchanged)', () => {
    // The fix: don't pretend there's a cost/revenue delta when the executor
    // isn't moving the budget. Volume-shift from a tROAS change is real but
    // belongs to a future tROAS-elasticity model, not this derivation.
    const c = base({ recommended_action: 'increase_troas_or_reduce_budget' })
    expect(deriveExpectedIncrements(c, 1000)).toEqual({ cost: 0, revenue: 0 })
  })

  it('null inputs propagate as null', () => {
    expect(
      deriveExpectedIncrements(base({ current_budget_brl: null }), 1100),
    ).toEqual({ cost: null, revenue: null })
    expect(deriveExpectedIncrements(base(), null)).toEqual({ cost: null, revenue: null })
  })
})

describe('deriveProjectedCos', () => {
  it('increase_budget: uses new_cost = current × (1 + |change|) in numerator', () => {
    // new_cost = 1100; expected_revenue = 350; cos = 1100/350 ≈ 3.143
    const c = base({ recommended_action: 'increase_budget' })
    expect(deriveProjectedCos(c, 350)).toBeCloseTo(1100 / 350, 5)
  })

  it('reduce_budget: uses new_cost = current × (1 − |change|)', () => {
    const c = base({ recommended_action: 'reduce_budget' })
    expect(deriveProjectedCos(c, 350)).toBeCloseTo(900 / 350, 5)
  })

  it('increase_troas_or_reduce_budget: new_cost = current (budget unchanged)', () => {
    // Was using current × (1 + change_percent) here too — same bug as
    // deriveProposedBudget. Now collapses to current.
    const c = base({ recommended_action: 'increase_troas_or_reduce_budget' })
    expect(deriveProjectedCos(c, 350)).toBeCloseTo(1000 / 350, 5)
  })

  it('returns null on missing inputs or zero revenue', () => {
    expect(deriveProjectedCos(base(), null)).toBeNull()
    expect(deriveProjectedCos(base(), 0)).toBeNull()
    expect(deriveProjectedCos(base({ current_budget_brl: null }), 350)).toBeNull()
  })
})

describe('deriveProposedTargetRoas', () => {
  it('increase_troas_or_reduce_budget: current × (1 + |change|)', () => {
    const c = base({ recommended_action: 'increase_troas_or_reduce_budget' })
    expect(deriveProposedTargetRoas(c)).toBe(5.5)
  })

  it('non-tROAS actions return null', () => {
    expect(deriveProposedTargetRoas(base({ recommended_action: 'increase_budget' }))).toBeNull()
    expect(deriveProposedTargetRoas(base({ recommended_action: 'reduce_budget' }))).toBeNull()
  })

  it('null current_target_roas returns null', () => {
    expect(
      deriveProposedTargetRoas(
        base({
          recommended_action: 'increase_troas_or_reduce_budget',
          current_target_roas: null,
        }),
      ),
    ).toBeNull()
  })
})
