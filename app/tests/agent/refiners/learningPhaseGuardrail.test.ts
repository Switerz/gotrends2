// tests/agent/refiners/learningPhaseGuardrail.test.ts
//
// Soft cap on bid mutates based on Smart Bidding system status. Exercised
// through refine() so we also cover the verdict-merge with the base + drift
// guardrails.

import { describe, it, expect } from 'vitest'
import { refine, type RefineContext } from '@/agent/refiners/refine'
import type { Candidate } from '@/agent/refiners/schema'

const TROAS_CANDIDATE: Candidate = {
  account_id: '7705857660',
  campaign_id: 'camp-1',
  campaign_name: 'Search NB',
  skill_type: 'budget_reallocation',
  recommended_action: 'increase_troas_or_reduce_budget',
  change_percent: 0.10,
  current_budget_brl: 1000,
  current_target_roas: 5.0,
  expected_marginal_roas: 3.5,
  confidence_score: 80,
  risk_level: 'low',
  reason: null,
}

const CTX: RefineContext = {
  runId: '00000000-0000-4000-8000-000000000000',
  recommendationId: '00000000-0000-4000-8000-000000000001',
}

describe('refine — learning phase guardrail', () => {
  it('stable + no other issue → verdict ok', () => {
    const r = refine(
      { ...TROAS_CANDIDATE, bidding_learning_status: 'stable' },
      CTX,
    )
    expect(r.guardrail_status).toBe('ok')
  })

  it('omitted (undefined) → no downgrade (missing data must not block normal recs)', () => {
    const r = refine(TROAS_CANDIDATE, CTX)
    expect(r.guardrail_status).toBe('ok')
  })

  it('unknown → no downgrade (same policy as undefined)', () => {
    const r = refine(
      { ...TROAS_CANDIDATE, bidding_learning_status: 'unknown' },
      CTX,
    )
    expect(r.guardrail_status).toBe('ok')
  })

  it('learning → downgrades to needs_human_review with structured reason', () => {
    const r = refine(
      { ...TROAS_CANDIDATE, bidding_learning_status: 'learning' },
      CTX,
    )
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toMatch(/bidding_learning_phase_active/)
    // Reason carries Portuguese context for the operator
    expect(r.guardrail_reason).toMatch(/Smart Bidding/)
  })

  it('limited → downgrades with a different structured reason', () => {
    const r = refine(
      { ...TROAS_CANDIDATE, bidding_learning_status: 'limited' },
      CTX,
    )
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toMatch(/bidding_strategy_limited/)
  })

  it('does NOT apply to non-tROAS actions (budget changes are passive)', () => {
    const r = refine(
      {
        ...TROAS_CANDIDATE,
        recommended_action: 'increase_budget',
        bidding_learning_status: 'learning',
      },
      CTX,
    )
    // Budget mutates don't trigger Smart Bidding re-learning. The guardrail
    // intentionally skips them.
    expect(r.guardrail_status).toBe('ok')
  })

  it('hard block (change_percent > 50%) wins over learning verdict', () => {
    const r = refine(
      {
        ...TROAS_CANDIDATE,
        change_percent: 0.60,
        bidding_learning_status: 'learning',
      },
      CTX,
    )
    // mergeVerdicts keeps the more severe — blocked > needs_human_review
    expect(r.guardrail_status).toBe('blocked')
    expect(r.guardrail_reason).toMatch(/change_above_50pct_hard_limit/)
  })

  it('drift cap and learning cap both apply: needs_human_review wins (same severity)', () => {
    // Both guardrails issue needs_human_review. mergeVerdicts is stable on
    // ties (prefers the first), so we expect a deterministic outcome — and
    // critically, the verdict does NOT escalate to blocked accidentally.
    const r = refine(
      { ...TROAS_CANDIDATE, bidding_learning_status: 'learning' },
      {
        ...CTX,
        troasDrift: { todayDriftPct: 0.50, sevenDayDriftPct: 0.50 },
      },
    )
    expect(r.guardrail_status).toBe('needs_human_review')
    // Reason is one of the two (we don't care which — both are valid here).
    expect(r.guardrail_reason).toMatch(
      /daily_troas_cap|bidding_learning_phase_active/,
    )
  })
})
