import { describe, it, expect } from 'vitest'
import {
  addLeverDiagnosis,
  diagnosePrimaryConstraint,
  recommendAction,
  DEFAULT_LEVER_CONFIG,
} from '@/models/leverDiagnosis'

describe('leverDiagnosis edge cases', () => {
  it('empty input → empty output', () => {
    expect(addLeverDiagnosis([])).toEqual([])
  })

  it('single row with no primary signals → monitor + monitor', () => {
    const out = addLeverDiagnosis([
      {
        company: 'A',
        campaign_id: 'c-1',
        current_roas: null,
        proxy_target_roas: null,
        marginal_roas: null,
        impression_share: null,
        lost_is_budget: null,
        ctr: null,
        cvr: null,
        campaign_type_avg_ctr: null,
        campaign_type_avg_cvr: null,
        confidence_score: 100,
        saturation_level: 'low',
        pure_budget_increase_blocked: false,
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.primary_constraint).toBe('monitor')
    expect(out[0]!.recommended_action).toBe('monitor')
  })

  it('all-null primary signals → monitor fallback (even with high confidence)', () => {
    const rows = [
      {
        company: 'X',
        campaign_id: 'c-x',
        confidence_score: 95,
        saturation_level: 'low',
        pure_budget_increase_blocked: false,
      },
      {
        company: 'Y',
        campaign_id: 'c-y',
        current_roas: null,
        proxy_target_roas: null,
        marginal_roas: null,
        impression_share: null,
        lost_is_budget: null,
        ctr: null,
        cvr: null,
        confidence_score: 90,
      },
    ]
    const out = addLeverDiagnosis(rows as any)
    for (const r of out) {
      expect(r.primary_constraint).toBe('monitor')
      expect(r.recommended_action).toBe('monitor')
    }
  })

  it('priority: saturated wins over budget_limited and scale_opportunity', () => {
    // roas_good (current>=proxy), high impression_share, lost_is_budget > .05,
    // marginal_good — would match every roas-good branch but 'saturated' is first.
    const c = diagnosePrimaryConstraint({
      current_roas: 5,
      proxy_target_roas: 2,
      marginal_roas: 3,
      impression_share: 0.95,
      lost_is_budget: 0.1,
    })
    expect(c).toBe('saturated')
  })

  it('priority: budget_limited beats scale_opportunity when both conditions hold', () => {
    const c = diagnosePrimaryConstraint({
      current_roas: 5,
      proxy_target_roas: 2,
      marginal_roas: 3,
      impression_share: 0.5, // below saturated threshold
      lost_is_budget: 0.1, // above budget_limited threshold
    })
    expect(c).toBe('budget_limited')
  })

  it('confidence < 40 forces monitor regardless of constraint', () => {
    const action = recommendAction({
      confidence_score: 39,
      primary_constraint: 'budget_limited',
      saturation_level: 'low',
      pure_budget_increase_blocked: false,
    })
    expect(action).toBe('monitor')
  })

  it('pure_budget_increase_blocked redirects scale path to optimize_efficiency', () => {
    const action = recommendAction({
      confidence_score: 95,
      primary_constraint: 'scale_opportunity',
      saturation_level: 'low',
      pure_budget_increase_blocked: true,
    })
    expect(action).toBe('optimize_efficiency')
  })

  it('accepts pandas-CSV "True"/"False" strings for pure_budget_increase_blocked', () => {
    const blocked = recommendAction({
      confidence_score: 95,
      primary_constraint: 'budget_limited',
      saturation_level: 'low',
      pure_budget_increase_blocked: 'True',
    })
    expect(blocked).toBe('optimize_efficiency')

    const unblocked = recommendAction({
      confidence_score: 95,
      primary_constraint: 'budget_limited',
      saturation_level: 'low',
      pure_budget_increase_blocked: 'False',
    })
    expect(unblocked).toBe('increase_budget')
  })

  it('low_efficiency with high confidence → increase_troas_or_reduce_budget', () => {
    const out = addLeverDiagnosis([
      {
        company: 'A',
        campaign_id: 'c-le',
        current_roas: 1,
        proxy_target_roas: 3,
        marginal_roas: 0.5,
        impression_share: 0.5,
        lost_is_budget: 0.01,
        confidence_score: DEFAULT_LEVER_CONFIG.minConfidenceForAction,
        saturation_level: 'high',
        pure_budget_increase_blocked: false,
      },
    ])
    expect(out[0]!.primary_constraint).toBe('low_efficiency')
    expect(out[0]!.recommended_action).toBe('increase_troas_or_reduce_budget')
  })

  it('relevance_issue path: ctr below 70% of avg_ctr', () => {
    const c = diagnosePrimaryConstraint({
      // roas signals absent so first 4 branches skip
      ctr: 0.01,
      campaign_type_avg_ctr: 0.05, // ctr < 0.05 * 0.7 = 0.035
      cvr: 0.05,
      campaign_type_avg_cvr: 0.05,
    })
    expect(c).toBe('relevance_issue')

    const action = recommendAction({
      confidence_score: 80,
      primary_constraint: 'relevance_issue',
    })
    expect(action).toBe('improve_ads_or_terms')
  })

  it('post_click_issue path: cvr below 70% of avg_cvr (after ctr branch skipped)', () => {
    const c = diagnosePrimaryConstraint({
      ctr: 0.05,
      campaign_type_avg_ctr: 0.05,
      cvr: 0.01,
      campaign_type_avg_cvr: 0.05, // cvr < 0.05 * 0.7 = 0.035
    })
    expect(c).toBe('post_click_issue')

    const action = recommendAction({
      confidence_score: 80,
      primary_constraint: 'post_click_issue',
    })
    expect(action).toBe('review_landing_or_offer')
  })

  it('saturated constraint → optimize_efficiency action', () => {
    const action = recommendAction({
      confidence_score: 100,
      primary_constraint: 'saturated',
      saturation_level: 'high',
      pure_budget_increase_blocked: true,
    })
    expect(action).toBe('optimize_efficiency')
  })

  it('scale_opportunity at high saturation does NOT increase budget', () => {
    // saturation_level must be 'low' or 'moderate' to unlock increase_budget
    const action = recommendAction({
      confidence_score: 90,
      primary_constraint: 'scale_opportunity',
      saturation_level: 'high',
      pure_budget_increase_blocked: false,
    })
    expect(action).toBe('monitor')
  })
})
