// tests/agent/refiners/refine.test.ts
//
// Refiner contract — see plan task 2.10c. Cover validation failures, enrichment
// derivations, and every guardrail branch, including hard-block precedence over
// review verdicts.

import { describe, it, expect } from 'vitest'
import { refine } from '@/agent/refiners/refine'
import { applyGuardrails } from '@/agent/refiners/guardrails'
import { CandidateInvalid, RecommendationSchemaViolation } from '@/core/errors'

const ctx = {
  runId: '00000000-0000-4000-8000-000000000001',
  recommendationId: '00000000-0000-4000-8000-000000000002',
}

const baseCandidate = {
  account_id: '7705857660',
  campaign_id: 'c-001',
  campaign_name: 'Search NB',
  skill_type: 'budget_reallocation',
  recommended_action: 'increase_budget' as const,
  change_percent: 0.10,
  current_budget_brl: 1000,
  current_target_roas: null,
  expected_marginal_roas: 3,
  confidence_score: 80,
  risk_level: 'medium' as const,
  reason: 'test',
}

describe('refine', () => {
  it('happy path: derives proposed budget, increments, ok guardrail', () => {
    const r = refine(baseCandidate, ctx)
    expect(r.proposed_budget_brl).toBe(1100)
    expect(r.expected_incremental_cost_brl).toBe(100)
    expect(r.expected_incremental_revenue_brl).toBe(300)
    expect(r.projected_cos).toBeCloseTo(1100 / 300, 6)
    expect(r.guardrail_status).toBe('ok')
    expect(r.guardrail_reason).toBeNull()
    expect(r.status).toBe('pending')
    expect(r.recommendation_id).toBe(ctx.recommendationId)
    expect(r.run_id).toBe(ctx.runId)
    expect(r.llm_payload).toBeNull()
    expect(r.llm_explanation).toBeNull()
    expect(r.expires_at).toBeNull()
  })

  it('blocks change_percent > 0.5', () => {
    const r = refine({ ...baseCandidate, change_percent: 0.80 }, ctx)
    expect(r.guardrail_status).toBe('blocked')
    expect(r.guardrail_reason).toBe('change_above_50pct_hard_limit')
  })

  it('blocks change_percent < -0.5', () => {
    const r = refine({ ...baseCandidate, change_percent: -0.60 }, ctx)
    expect(r.guardrail_status).toBe('blocked')
    expect(r.guardrail_reason).toBe('change_above_50pct_hard_limit')
  })

  it('routes low confidence (<40) to needs_human_review', () => {
    const r = refine({ ...baseCandidate, confidence_score: 30 }, ctx)
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toBe('confidence_below_threshold')
  })

  it('routes high risk_level to needs_human_review', () => {
    const r = refine({ ...baseCandidate, risk_level: 'high' }, ctx)
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toBe('risk_level_high')
  })

  it('routes roas_anomaly to needs_human_review', () => {
    const r = refine(
      { ...baseCandidate, anomaly_flags: { roas_anomaly: true } },
      ctx,
    )
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toBe('critical_metric_anomaly')
  })

  it('routes cost_anomaly to needs_human_review', () => {
    const r = refine(
      { ...baseCandidate, anomaly_flags: { cost_anomaly: true } },
      ctx,
    )
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toBe('critical_metric_anomaly')
  })

  it('throws CandidateInvalid on malformed action', () => {
    expect(() =>
      refine({ ...baseCandidate, recommended_action: 'lol' } as unknown, ctx),
    ).toThrow(CandidateInvalid)
  })

  it('throws CandidateInvalid on missing required field', () => {
    const { account_id: _omit, ...rest } = baseCandidate
    expect(() => refine(rest as unknown, ctx)).toThrow(CandidateInvalid)
  })

  it('throws CandidateInvalid on confidence > 100', () => {
    expect(() =>
      refine({ ...baseCandidate, confidence_score: 150 }, ctx),
    ).toThrow(CandidateInvalid)
  })

  it('proposed_target_roas only set for increase_troas_or_reduce_budget', () => {
    const r1 = refine(baseCandidate, ctx)
    expect(r1.proposed_target_roas).toBeNull()

    const r2 = refine(
      {
        ...baseCandidate,
        recommended_action: 'increase_troas_or_reduce_budget',
        current_target_roas: 4.0,
        change_percent: 0.15,
      },
      ctx,
    )
    expect(r2.proposed_target_roas).toBeCloseTo(4.6, 2)
  })

  it('projected_cos is null when expected_revenue is 0', () => {
    const r = refine({ ...baseCandidate, expected_marginal_roas: 0 }, ctx)
    expect(r.expected_incremental_revenue_brl).toBe(0)
    expect(r.projected_cos).toBeNull()
  })

  it('all null derived fields when change_percent is null', () => {
    const r = refine({ ...baseCandidate, change_percent: null }, ctx)
    expect(r.proposed_budget_brl).toBeNull()
    expect(r.expected_incremental_cost_brl).toBeNull()
    expect(r.expected_incremental_revenue_brl).toBeNull()
    expect(r.projected_cos).toBeNull()
  })

  it('throws RecommendationSchemaViolation on bad uuid in ctx', () => {
    expect(() =>
      refine(baseCandidate, {
        runId: 'not-a-uuid',
        recommendationId: ctx.recommendationId,
      }),
    ).toThrow(RecommendationSchemaViolation)
  })

  // ---------------------------------------------------------------------------
  // Boundary tests for guardrail thresholds.
  // ---------------------------------------------------------------------------

  it('change_percent exactly at MAX (0.5) is ok', () => {
    const r = refine({ ...baseCandidate, change_percent: 0.5 }, ctx)
    expect(r.guardrail_status).toBe('ok')
  })

  it('change_percent exactly at -MAX (-0.5) is ok', () => {
    const r = refine({ ...baseCandidate, change_percent: -0.5 }, ctx)
    expect(r.guardrail_status).toBe('ok')
  })

  it('confidence_score exactly at threshold (40) is ok', () => {
    const r = refine({ ...baseCandidate, confidence_score: 40 }, ctx)
    expect(r.guardrail_status).toBe('ok')
  })

  it('confidence_score one below threshold (39) is needs_human_review', () => {
    const r = refine({ ...baseCandidate, confidence_score: 39 }, ctx)
    expect(r.guardrail_status).toBe('needs_human_review')
  })
})

describe('applyGuardrails', () => {
  it('hard block precedence: change_percent=0.8 + confidence=30 → blocked (not review)', () => {
    const v = applyGuardrails({
      ...baseCandidate,
      change_percent: 0.80,
      confidence_score: 30,
    })
    expect(v.status).toBe('blocked')
    expect(v.reason).toBe('change_above_50pct_hard_limit')
  })

  it('ok when no rule fires', () => {
    const v = applyGuardrails(baseCandidate)
    expect(v.status).toBe('ok')
    expect(v.reason).toBeNull()
  })
})
