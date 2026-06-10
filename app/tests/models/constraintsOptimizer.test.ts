import { describe, it, expect } from 'vitest'
import {
  actionKind,
  applyGuardrails,
  DEFAULT_GUARDRAIL_CONFIG,
} from '@/models/constraintsOptimizer'

const D = '2026-06-10'

function row(overrides: Record<string, unknown> = {}) {
  return {
    date: D,
    company: 'Apice',
    campaign_id: 'c-x',
    confidence_score: 80,
    recommended_action: 'monitor',
    recommended_change_pct: 0.1,
    impression_share: 0.5,
    ...overrides,
  }
}

describe('actionKind', () => {
  it('maps increase_budget → budget', () => {
    expect(actionKind('increase_budget')).toBe('budget')
  })
  it('maps increase_troas_or_reduce_budget → bid', () => {
    expect(actionKind('increase_troas_or_reduce_budget')).toBe('bid')
  })
  it('maps anything else → other', () => {
    expect(actionKind('monitor')).toBe('other')
    expect(actionKind('improve_ads_or_terms')).toBe('other')
    expect(actionKind(null)).toBe('other')
    expect(actionKind(undefined)).toBe('other')
  })
})

describe('applyGuardrails', () => {
  it('empty input → empty output', () => {
    expect(applyGuardrails([])).toEqual([])
  })

  it('all-monitor candidates stay at default needs_human_review', () => {
    const out = applyGuardrails([
      row({ campaign_id: 'a' }),
      row({ campaign_id: 'b' }),
    ])
    for (const r of out) {
      expect(r.action_kind).toBe('other')
      expect(r.business_constraints_status).toBe('needs_human_review')
      expect(r.constraints_reason).toBe(
        'manual_learning_test_and_real_cos_sources_missing',
      )
      expect(r.budget_action_rank).toBeNull()
      expect(r.bid_action_rank).toBeNull()
    }
  })

  it('budget actions get per-date ranks ordered by confidence desc', () => {
    const out = applyGuardrails([
      row({ campaign_id: 'low', recommended_action: 'increase_budget', confidence_score: 70 }),
      row({ campaign_id: 'high', recommended_action: 'increase_budget', confidence_score: 95 }),
      row({ campaign_id: 'mid', recommended_action: 'increase_budget', confidence_score: 80 }),
    ])
    const byId = new Map(out.map(r => [r.campaign_id, r]))
    expect(byId.get('high')!.budget_action_rank).toBe(1)
    expect(byId.get('mid')!.budget_action_rank).toBe(2)
    expect(byId.get('low')!.budget_action_rank).toBe(3)
    // None blocked (3 budget actions ≤ default max 3).
    for (const r of out) {
      expect(r.business_constraints_status).toBe('needs_human_review')
    }
  })

  it('budget action rank > maxBudgetChangesPerDay → blocked_by_daily_budget_change_limit', () => {
    const out = applyGuardrails(
      [
        row({ campaign_id: 'a', recommended_action: 'increase_budget', confidence_score: 99 }),
        row({ campaign_id: 'b', recommended_action: 'increase_budget', confidence_score: 90 }),
        row({ campaign_id: 'c', recommended_action: 'increase_budget', confidence_score: 80 }),
        row({ campaign_id: 'd', recommended_action: 'increase_budget', confidence_score: 70 }),
      ],
      { ...DEFAULT_GUARDRAIL_CONFIG, maxBudgetChangesPerDay: 3 },
    )
    const byId = new Map(out.map(r => [r.campaign_id, r]))
    expect(byId.get('a')!.business_constraints_status).toBe('needs_human_review')
    expect(byId.get('c')!.business_constraints_status).toBe('needs_human_review')
    expect(byId.get('d')!.business_constraints_status).toBe('blocked')
    expect(byId.get('d')!.constraints_reason).toBe(
      'blocked_by_daily_budget_change_limit',
    )
  })

  it('bid action rank > maxBidChangesPerDay → blocked_by_daily_bid_change_limit', () => {
    const out = applyGuardrails([
      row({
        campaign_id: 'a',
        recommended_action: 'increase_troas_or_reduce_budget',
        confidence_score: 99,
        recommended_change_pct: 0.1,
      }),
      row({
        campaign_id: 'b',
        recommended_action: 'increase_troas_or_reduce_budget',
        confidence_score: 90,
        recommended_change_pct: 0.1,
      }),
    ])
    const byId = new Map(out.map(r => [r.campaign_id, r]))
    expect(byId.get('a')!.business_constraints_status).toBe('needs_human_review')
    expect(byId.get('b')!.business_constraints_status).toBe('blocked')
    expect(byId.get('b')!.constraints_reason).toBe(
      'blocked_by_daily_bid_change_limit',
    )
  })

  it('|recommended_change_pct| > maxBidChangePct → blocked_by_bid_change_pct_limit (overrides bid_count)', () => {
    const out = applyGuardrails([
      // Two bid actions: rank 1 has pct in limit; rank 2 has pct over.
      row({
        campaign_id: 'rank1',
        recommended_action: 'increase_troas_or_reduce_budget',
        confidence_score: 99,
        recommended_change_pct: -0.25, // |0.25| > 0.20 → bid_pct
      }),
      row({
        campaign_id: 'rank2',
        recommended_action: 'increase_troas_or_reduce_budget',
        confidence_score: 90,
        recommended_change_pct: 0.3, // both bid_count and bid_pct trigger; pct wins
      }),
    ])
    const byId = new Map(out.map(r => [r.campaign_id, r]))
    expect(byId.get('rank1')!.business_constraints_status).toBe('blocked')
    expect(byId.get('rank1')!.constraints_reason).toBe(
      'blocked_by_bid_change_pct_limit',
    )
    expect(byId.get('rank2')!.business_constraints_status).toBe('blocked')
    expect(byId.get('rank2')!.constraints_reason).toBe(
      'blocked_by_bid_change_pct_limit',
    )
  })

  it('budget action with impression_share >= 0.90 → blocked_by_impression_share (highest priority)', () => {
    const out = applyGuardrails([
      row({
        campaign_id: 'sat',
        recommended_action: 'increase_budget',
        impression_share: 0.95,
        confidence_score: 99,
      }),
      // also push rank past the limit to verify impression_share wins.
      row({ campaign_id: 'b', recommended_action: 'increase_budget', confidence_score: 90 }),
      row({ campaign_id: 'c', recommended_action: 'increase_budget', confidence_score: 80 }),
      row({ campaign_id: 'd', recommended_action: 'increase_budget', confidence_score: 70, impression_share: 0.99 }),
    ])
    const byId = new Map(out.map(r => [r.campaign_id, r]))
    expect(byId.get('sat')!.constraints_reason).toBe(
      'blocked_by_impression_share',
    )
    // 'd' is both over budget rank (4 > 3) AND impression_share >= 0.90 →
    // impression_share is applied last so it wins.
    expect(byId.get('d')!.constraints_reason).toBe('blocked_by_impression_share')
  })

  it('ranks are computed per date independently', () => {
    const out = applyGuardrails([
      row({ date: '2026-06-09', campaign_id: 'a', recommended_action: 'increase_budget', confidence_score: 80 }),
      row({ date: '2026-06-09', campaign_id: 'b', recommended_action: 'increase_budget', confidence_score: 70 }),
      row({ date: '2026-06-10', campaign_id: 'c', recommended_action: 'increase_budget', confidence_score: 95 }),
    ])
    const byId = new Map(out.map(r => [r.campaign_id, r]))
    expect(byId.get('a')!.budget_action_rank).toBe(1)
    expect(byId.get('b')!.budget_action_rank).toBe(2)
    expect(byId.get('c')!.budget_action_rank).toBe(1)
  })

  it('missing impression_share on budget action → no impression-share block', () => {
    const out = applyGuardrails([
      row({
        campaign_id: 'a',
        recommended_action: 'increase_budget',
        impression_share: null as unknown as number,
      }),
    ])
    expect(out[0]!.business_constraints_status).toBe('needs_human_review')
  })

  it('non-bid recommended_change_pct over limit does not trigger bid_pct block', () => {
    const out = applyGuardrails([
      row({
        campaign_id: 'a',
        recommended_action: 'increase_budget',
        recommended_change_pct: 0.9, // huge, but action is budget so bid_pct rule is mute
        impression_share: 0.5,
      }),
    ])
    expect(out[0]!.business_constraints_status).toBe('needs_human_review')
    expect(out[0]!.action_kind).toBe('budget')
  })

  it('preserves all input columns (does not strip)', () => {
    const out = applyGuardrails([
      row({ campaign_id: 'a', primary_constraint: 'low_efficiency', custom: 42 }),
    ])
    expect((out[0] as any).primary_constraint).toBe('low_efficiency')
    expect((out[0] as any).custom).toBe(42)
    expect(out[0]!.action_kind).toBe('other')
  })
})
