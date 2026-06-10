import { describe, it, expect } from 'vitest'
import { addCampaignScores } from '@/models/campaignScores'

type InputRow = {
  company: string
  campaign_id: string
  marginal_roas?: number | null
  proxy_target_roas?: number | null
  lost_is_budget?: number | null
  impression_share?: number | null
  lost_is_rank?: number | null
  trend_status?: string | null
  current_roas?: number | null
  current_cost?: number | null
  cost_28d?: number | null
  ctr?: number | null
  cvr?: number | null
  cpc?: number | null
  campaign_type_avg_ctr?: number | null
  campaign_type_avg_cvr?: number | null
  campaign_type_avg_cpc?: number | null
  confidence_score?: number | null
  saturation_level?: string | null
}

function baseRow(overrides: Partial<InputRow> = {}): InputRow {
  return {
    company: 'Acme',
    campaign_id: 'c-x',
    marginal_roas: 1,
    proxy_target_roas: 1,
    lost_is_budget: 0,
    impression_share: 0.5,
    lost_is_rank: 0,
    trend_status: 'normal',
    current_roas: 1,
    current_cost: 0,
    cost_28d: 1000,
    ctr: 0.03,
    cvr: 0.02,
    cpc: 1,
    campaign_type_avg_ctr: 0.03,
    campaign_type_avg_cvr: 0.02,
    campaign_type_avg_cpc: 1,
    confidence_score: 80,
    saturation_level: 'low',
    ...overrides,
  }
}

describe('addCampaignScores edge cases', () => {
  it('empty input returns empty array', () => {
    expect(addCampaignScores([])).toEqual([])
  })

  it('single row computes all derived scores', () => {
    const out = addCampaignScores([baseRow()])
    expect(out).toHaveLength(1)
    const r = out[0]!
    expect(r.marginal_roas_score).toBeCloseTo(50, 10)
    expect(r.opportunity_score).toBeCloseTo(25, 10)
    expect(r.budget_limitation_score).toBeCloseTo(0, 10)
    expect(r.stability_score).toBe(100)
    expect(r.roas_below_target_score).toBeCloseTo(0, 10)
    expect(r.negative_trend_score).toBe(25)
    expect(r.saturation_score).toBe(10)
    expect(r.wasted_spend_score).toBeCloseTo(0, 10)
    expect(r.maintenance_score).toBe(0)
    expect(typeof r.scale_score).toBe('number')
    expect(typeof r.efficiency_risk_score).toBe('number')
  })

  it('proxy_target_roas = 0 yields safe (zero) marginal_roas_score and roas_below_target_score', () => {
    const out = addCampaignScores([
      baseRow({ proxy_target_roas: 0, marginal_roas: 5, current_roas: 3 }),
    ])
    const r = out[0]!
    // division by zero → clipScore(null) → 0
    expect(r.marginal_roas_score).toBe(0)
    expect(r.roas_below_target_score).toBe(0)
    expect(Number.isNaN(r.scale_score)).toBe(false)
    expect(Number.isNaN(r.efficiency_risk_score)).toBe(false)
  })

  it('proxy_target_roas = null yields safe zeros (no NaN propagation)', () => {
    const out = addCampaignScores([
      baseRow({ proxy_target_roas: null, marginal_roas: 5, current_roas: 3 }),
    ])
    const r = out[0]!
    expect(r.marginal_roas_score).toBe(0)
    expect(r.roas_below_target_score).toBe(0)
    expect(Number.isFinite(r.scale_score)).toBe(true)
    expect(Number.isFinite(r.efficiency_risk_score)).toBe(true)
  })

  it('extreme inputs clip to [0, 100] bounds', () => {
    // Force every component near or beyond bounds
    const out = addCampaignScores([
      baseRow({
        marginal_roas: 1000,
        proxy_target_roas: 1, // marginal_roas_score → 50_000 → clipped to 100
        lost_is_budget: 5, // opportunity_score & budget_limitation_score → very large → clipped
        impression_share: -10,
        current_roas: -1000, // roas_below_target_score → huge positive → 100
        current_cost: 10000,
        cost_28d: 1, // wasted_spend_score → 2_800_000 → 100
        lost_is_rank: 10, // maintenance_score → 700 → 100
        ctr: 0,
        cvr: 0,
        cpc: 1000,
        confidence_score: 100,
        saturation_level: 'critical',
        trend_status: 'strong_negative',
      }),
    ])
    const r = out[0]!
    expect(r.marginal_roas_score).toBe(100)
    expect(r.opportunity_score).toBe(100)
    expect(r.budget_limitation_score).toBe(100)
    expect(r.stability_score).toBe(0)
    expect(r.roas_below_target_score).toBe(100)
    expect(r.negative_trend_score).toBe(100)
    expect(r.saturation_score).toBe(100)
    expect(r.wasted_spend_score).toBe(100)
    expect(r.maintenance_score).toBe(100)
    expect(r.scale_score).toBeLessThanOrEqual(100)
    expect(r.scale_score).toBeGreaterThanOrEqual(0)
    expect(r.efficiency_risk_score).toBeLessThanOrEqual(100)
    expect(r.efficiency_risk_score).toBeGreaterThanOrEqual(0)
  })

  it('negative trend lifts negative_trend_score and drops stability_score', () => {
    const negRow = addCampaignScores([baseRow({ trend_status: 'negative' })])[0]!
    expect(negRow.negative_trend_score).toBe(70)
    expect(negRow.stability_score).toBe(50)

    const strongNeg = addCampaignScores([baseRow({ trend_status: 'strong_negative' })])[0]!
    expect(strongNeg.negative_trend_score).toBe(100)
    expect(strongNeg.stability_score).toBe(0)
  })

  it('high marginal_roas relative to target lifts scale_score (via marginal_roas_score = 100)', () => {
    const out = addCampaignScores([
      baseRow({
        marginal_roas: 10,
        proxy_target_roas: 2, // 50 * 10 / 2 = 250 → clipped to 100
        lost_is_budget: 0.5,
        impression_share: 0.4,
        confidence_score: 100,
        trend_status: 'strong_positive',
      }),
    ])
    const r = out[0]!
    expect(r.marginal_roas_score).toBe(100)
    // scale = 0.30*100 + 0.25*opp + 0.20*bl + 0.15*100 + 0.10*100
    //       = 30 + 0.25*opportunity + 0.20*budget_limitation + 15 + 10
    // With lost_is_budget=0.5 -> opportunity = 50 + (1-0.4)*50 = 80, budget_limitation=50
    // = 30 + 20 + 10 + 15 + 10 = 85
    expect(r.scale_score).toBe(85)
  })

  it('preserves arbitrary input columns and order of rows', () => {
    const input = [
      baseRow({ company: 'A', campaign_id: 'c-1', trend_status: 'positive' }),
      baseRow({ company: 'B', campaign_id: 'c-2', trend_status: 'negative' }),
    ]
    const out = addCampaignScores(input)
    expect(out.map(r => r.campaign_id)).toEqual(['c-1', 'c-2'])
    expect(out[0]!.company).toBe('A')
    // Input columns should be retained
    expect(out[0]!.marginal_roas).toBe(input[0]!.marginal_roas)
  })

  it('null trend_status / saturation_level default correctly', () => {
    const out = addCampaignScores([
      baseRow({ trend_status: null, saturation_level: null }),
    ])
    const r = out[0]!
    expect(r.stability_score).toBe(40) // default branch
    expect(r.negative_trend_score).toBe(0) // default branch
    expect(r.saturation_score).toBe(40) // fillna(40)
  })
})
