import { describe, it, expect } from 'vitest'
import {
  addSpendBands,
  buildCampaignElasticityFeatures,
  buildSpendBandSummary,
  estimateLogLogElasticity,
  DEFAULT_ELASTICITY_CONFIG,
  type DailyInputRow,
} from '@/models/marginalElasticity'

function makeDays(
  campaign: { id: string; name: string; type: string; company?: string },
  values: Array<{ date: string; cost: number; cv: number }>,
): DailyInputRow[] {
  return values.map(v => ({
    date: v.date,
    company: campaign.company ?? 'Apice',
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    campaign_type: campaign.type,
    cost: v.cost,
    conversion_value: v.cv,
  }))
}

const isoDay = (i: number): string => {
  const d = new Date(Date.UTC(2026, 0, 1 + i))
  return d.toISOString().slice(0, 10)
}

describe('marginalElasticity edge cases', () => {
  it('empty input returns []', () => {
    expect(buildCampaignElasticityFeatures([])).toEqual([])
  })

  it('filters out rows where cost <= 0 or NaN before all downstream work', () => {
    const rows = makeDays(
      { id: 'c-x', name: 'X', type: 'search' },
      [
        { date: '2026-01-01', cost: 0, cv: 50 }, // dropped
        { date: '2026-01-02', cost: -10, cv: 20 }, // dropped
        { date: '2026-01-03', cost: NaN as unknown as number, cv: 5 }, // dropped
      ],
    )
    // After filtering nothing remains → output is []
    expect(buildCampaignElasticityFeatures(rows)).toEqual([])
  })

  it('single campaign with single day → fallback to campaign_type with single band', () => {
    const rows = makeDays(
      { id: 'c-1', name: 'Solo', type: 'search' },
      [{ date: '2026-01-01', cost: 500, cv: 1000 }],
    )
    const out = buildCampaignElasticityFeatures(rows)
    expect(out).toHaveLength(1)
    const r = out[0]!
    expect(r.days_with_spend).toBe(1)
    expect(r.positive_revenue_days).toBe(1)
    expect(r.current_cost).toBe(500)
    expect(r.current_roas).toBe(2)
    // 1 day < min_campaign_days=28 → falls back to campaign_type level
    expect(r.model_level_used).toBe('campaign_type')
    // single-day group → single band → marginal_roas null (no .diff() partner)
    expect(r.marginal_roas).toBeNull()
    // elasticity surfaced only when model_level_used === 'campaign'
    expect(r.elasticity).toBeNull()
    expect(r.recommended_spend_band_min).toBe(500)
    expect(r.recommended_spend_band_max).toBe(500)
  })

  it('campaign with constant cost (variance=0): bands collapse → fallback to type bands', () => {
    // 30 days @ cost=1000 with non-zero conversion_value on most days.
    // Days_with_spend>=28 and positive_revenue_days>=14 hold, but every band
    // gets avg_cost=1000 → incremental_cost=0 everywhere → marginal_roas all NaN
    // → algorithm falls back to campaign_type, elasticity blanked.
    const days: Array<{ date: string; cost: number; cv: number }> = []
    for (let i = 0; i < 30; i++) {
      days.push({ date: isoDay(i), cost: 1000, cv: 1000 + i * 10 })
    }
    const out = buildCampaignElasticityFeatures(
      makeDays({ id: 'c-flat', name: 'Flat', type: 'shopping' }, days),
    )
    expect(out).toHaveLength(1)
    const r = out[0]!
    expect(r.model_level_used).toBe('campaign_type')
    expect(r.marginal_roas).toBeNull()
    // log-log slope returns null when var(log(cost)) ~ 0; combined with the
    // campaign_type fallback, elasticity is suppressed anyway.
    expect(r.elasticity).toBeNull()
  })

  it('campaign with < min_campaign_days falls back to campaign_type bands', () => {
    // 10 days for c-short (< 28) — should fall back; share a type with c-long
    // so the type-level bands have varied spend to recommend against.
    const shortDays = Array.from({ length: 10 }, (_, i) => ({
      date: isoDay(i),
      cost: 100 + i * 10,
      cv: 200 + i * 30,
    }))
    const longDays = Array.from({ length: 40 }, (_, i) => ({
      date: isoDay(i + 10),
      cost: 50 + i * 5,
      cv: 90 + i * 9,
    }))
    const input: DailyInputRow[] = [
      ...makeDays({ id: 'c-short', name: 'Short', type: 'search' }, shortDays),
      ...makeDays({ id: 'c-long', name: 'Long', type: 'search' }, longDays),
    ]
    const out = buildCampaignElasticityFeatures(input)
    const short = out.find(r => r.campaign_id === 'c-short')!
    expect(short.days_with_spend).toBe(10)
    expect(short.model_level_used).toBe('campaign_type')
    expect(short.elasticity).toBeNull()
    expect(short.recommended_spend_band_min).not.toBeNull()
  })

  it('latest day in highest band → recommended band is the top band', () => {
    // 30 ascending-cost days. Latest day = highest cost → lives in band 4.
    // Recommended band's max equals that latest cost.
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: isoDay(i),
      cost: 100 + i * 10, // 100..390 ascending
      cv: 200 + i * 25,
    }))
    const out = buildCampaignElasticityFeatures(
      makeDays({ id: 'c-top', name: 'Top', type: 'search' }, days),
    )
    const r = out[0]!
    expect(r.current_cost).toBe(390)
    // The latest day falls inside the top band, so band_max == current_cost.
    expect(r.recommended_spend_band_max).toBe(390)
    // And band_min is strictly less than band_max for an ascending sequence.
    expect(r.recommended_spend_band_min!).toBeLessThan(390)
  })

  it('campaign with all conversion_value = 0 → elasticity null, marginal_roas defined', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: isoDay(i),
      cost: 100 + i * 5,
      cv: 0,
    }))
    const out = buildCampaignElasticityFeatures(
      makeDays({ id: 'c-zero', name: 'Zero', type: 'display' }, days),
    )
    expect(out).toHaveLength(1)
    const r = out[0]!
    // log-log needs cv>0 — never satisfied → elasticity null
    // also positive_revenue_days = 0 < min_positive_revenue_days → fallback to type
    expect(r.positive_revenue_days).toBe(0)
    expect(r.model_level_used).toBe('campaign_type')
    expect(r.elasticity).toBeNull()
    // marginal_roas across bands: incremental_cv = 0 - 0 = 0, /inc_cost = 0/n = 0
    expect(r.marginal_roas).toBe(0)
  })

  it('multiple campaigns of same type: campaign_type bands aggregate across both', () => {
    const aDays = Array.from({ length: 30 }, (_, i) => ({
      date: isoDay(i),
      cost: 100 + i * 2,
      cv: 200 + i * 4,
    }))
    const bDays = Array.from({ length: 30 }, (_, i) => ({
      date: isoDay(i),
      cost: 500 + i * 5,
      cv: 1000 + i * 8,
    }))
    const input: DailyInputRow[] = [
      ...makeDays({ id: 'c-a', name: 'A', type: 'search' }, aDays),
      ...makeDays({ id: 'c-b', name: 'B', type: 'search' }, bDays),
    ]
    const out = buildCampaignElasticityFeatures(input)
    expect(out).toHaveLength(2)
    for (const r of out) {
      expect(r.recommended_spend_band_min).not.toBeNull()
      expect(r.recommended_spend_band_max).not.toBeNull()
    }
  })

  it('estimateLogLogElasticity: returns null for <3 valid rows', () => {
    expect(estimateLogLogElasticity([])).toBeNull()
    expect(
      estimateLogLogElasticity([
        { date: '', company: '', campaign_id: '', campaign_name: '', campaign_type: '', cost: 100, conversion_value: 200 },
        { date: '', company: '', campaign_id: '', campaign_name: '', campaign_type: '', cost: 200, conversion_value: 400 },
      ]),
    ).toBeNull()
  })

  it('estimateLogLogElasticity: log-log on y=2x → slope ~1', () => {
    const rows: DailyInputRow[] = [1, 2, 4, 8, 16].map(c => ({
      date: '',
      company: '',
      campaign_id: '',
      campaign_name: '',
      campaign_type: '',
      cost: c,
      conversion_value: 2 * c,
    }))
    const s = estimateLogLogElasticity(rows)!
    expect(s).toBeCloseTo(1, 10)
  })

  it('addSpendBands: single-row group → band=1; constant-cost group → unique ranks', () => {
    const rows = [
      // single-row group keyed by (Apice, A): explicitly hits the len<=1 branch
      { date: 'd1', company: 'Apice', campaign_id: 'A', campaign_name: '', campaign_type: '', cost: 999, conversion_value: 0 },
      // 4 constant-cost rows → unique index-tied ranks → bands 1..4
      ...[1, 2, 3, 4].map(i => ({
        date: `d${i}`,
        company: 'Apice',
        campaign_id: 'B',
        campaign_name: '',
        campaign_type: '',
        cost: 100,
        conversion_value: 0,
      })),
    ]
    const banded = addSpendBands(rows, r => `${r.company}|${r.campaign_id}`, DEFAULT_ELASTICITY_CONFIG)
    expect(banded[0]!.spend_band).toBe(1) // single-row group
    const bGroup = banded.slice(1).map(r => r.spend_band)
    expect(bGroup).toEqual([1, 2, 3, 4])
  })

  it('buildSpendBandSummary: first band has null incremental_*; subsequent rows compute marginal_roas', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      date: `d${i}`,
      company: 'Apice',
      campaign_id: 'C',
      campaign_name: '',
      campaign_type: 'search',
      cost: 10 + i * 10, // 10..80
      conversion_value: 20 + i * 30, // 20..230
    }))
    const summary = buildSpendBandSummary(rows, r => `${r.company}|${r.campaign_id}`)
    const bands = summary.get('Apice|C')!
    expect(bands).toHaveLength(4)
    expect(bands[0]!.incremental_cost).toBeNull()
    expect(bands[0]!.marginal_roas).toBeNull()
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.incremental_cost).not.toBeNull()
      expect(bands[i]!.marginal_roas).not.toBeNull()
    }
  })
})
