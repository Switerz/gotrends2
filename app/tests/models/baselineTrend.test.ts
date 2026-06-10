import { describe, it, expect } from 'vitest'
import { buildBaselineTrendFeatures } from '@/models/baselineTrend'

type RawRow = {
  date: string
  company: string
  campaign_id: string
  campaign_type?: string
  cost: number | null
  conversion_value: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
}

function row(overrides: Partial<RawRow> & { date: string; campaign_id: string }): RawRow {
  return {
    company: 'Apice',
    campaign_type: 'search',
    cost: 0,
    conversion_value: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    ...overrides,
  } as RawRow
}

describe('buildBaselineTrendFeatures edge cases', () => {
  it('returns [] on empty input', () => {
    expect(buildBaselineTrendFeatures([])).toEqual([])
  })

  it('single row → all derived rolling/EWMA columns null, base ratios computed', () => {
    const out = buildBaselineTrendFeatures([
      row({ date: '2026-04-13', campaign_id: 'c-A', impressions: 100, clicks: 10, cost: 20, conversions: 2, conversion_value: 60 }),
    ])
    expect(out).toHaveLength(1)
    const r = out[0]!
    // base ratios
    expect(r['ctr']).toBeCloseTo(0.1, 12)
    expect(r['cpc']).toBeCloseTo(2.0, 12)
    expect(r['cvr']).toBeCloseTo(0.2, 12)
    expect(r['roas']).toBeCloseTo(3.0, 12)
    // no prior rows → rolling sums and EWMA all null
    for (const c of [
      'cost_7d',
      'conversion_value_7d',
      'roas_7d',
      'cost_14d',
      'conversion_value_14d',
      'roas_14d',
      'cost_28d',
      'conversion_value_28d',
      'roas_28d',
      'clicks_28d',
      'conversions_28d',
      'same_weekday_roas',
      'ewma_roas',
    ]) {
      expect(r[c]).toBeNull()
    }
    // trend_status needs both roas and roas_28d → insufficient_data
    expect(r['trend_status']).toBe('insufficient_data')
  })

  it('all-zero cost → roas = null on every row', () => {
    const rows = [
      row({ date: '2026-04-12', campaign_id: 'c-Z', impressions: 100, clicks: 10, cost: 0, conversion_value: 0 }),
      row({ date: '2026-04-13', campaign_id: 'c-Z', impressions: 200, clicks: 20, cost: 0, conversion_value: 5 }),
      row({ date: '2026-04-14', campaign_id: 'c-Z', impressions: 100, clicks: 10, cost: 0, conversion_value: 0 }),
    ]
    const out = buildBaselineTrendFeatures(rows)
    for (const r of out) {
      expect(r['roas']).toBeNull()
    }
    // ewma_roas is all null because all roas are null (no first finite seed)
    for (const r of out) {
      expect(r['ewma_roas']).toBeNull()
    }
  })

  it('8+ same-weekday rows → same_weekday_roas computed', () => {
    // Construct a campaign with 10 weeks of data on Mondays + filler so we get >=8 same-weekday rows.
    // Generate every day for 10 weeks (70 days), starting at a Monday (2026-04-13 is a Monday).
    const rows: RawRow[] = []
    const start = new Date('2026-04-13T00:00:00Z')
    for (let i = 0; i < 70; i++) {
      const d = new Date(start.getTime() + i * 86_400_000)
      const iso = d.toISOString().slice(0, 10)
      rows.push(
        row({
          date: iso,
          campaign_id: 'c-W',
          impressions: 1000,
          clicks: 100,
          cost: 50,
          conversions: 5,
          conversion_value: 150,
        }),
      )
    }
    const out = buildBaselineTrendFeatures(rows)
    // pandas weekday 0 = Monday → JS getUTCDay 1 → (1+6)%7=0. The first Monday row
    // has no prior same-weekday data → same_weekday_roas null. The second Monday
    // (8 days later) has 1 prior → numeric.
    const mondays = out.filter(r => r['weekday'] === 0)
    expect(mondays.length).toBe(10)
    expect(mondays[0]!['same_weekday_roas']).toBeNull()
    // ROAS each row = 150/50 = 3.0; with the rolling-sum-of-prior semantics:
    // same_weekday_roas = sum(prior 8 same-weekday cv) / sum(prior 8 same-weekday cost) = 3.0.
    expect(mondays[1]!['same_weekday_roas']).toBeCloseTo(3.0, 12)
    expect(mondays[5]!['same_weekday_roas']).toBeCloseTo(3.0, 12)
  })

  it('null/NaN in cost or impressions → propagates as null in derived ratios', () => {
    const rows = [
      row({ date: '2026-04-12', campaign_id: 'c-N', impressions: null as unknown as number, clicks: 10, cost: 20, conversions: 1, conversion_value: 50 }),
      row({ date: '2026-04-13', campaign_id: 'c-N', impressions: 100, clicks: 10, cost: null as unknown as number, conversions: 1, conversion_value: 50 }),
    ]
    const out = buildBaselineTrendFeatures(rows)
    // row 0: impressions=null → ctr=null. cost=20 → cpc=2. cost finite → roas=50/20=2.5
    expect(out[0]!['ctr']).toBeNull()
    expect(out[0]!['cpc']).toBeCloseTo(2.0, 12)
    expect(out[0]!['roas']).toBeCloseTo(2.5, 12)
    // row 1: cost=null → cpc=null, roas=null
    expect(out[1]!['cpc']).toBeNull()
    expect(out[1]!['roas']).toBeNull()
  })

  it('date with weekday Sunday in JS (getUTCDay=0) → pandas weekday=6', () => {
    // 2026-04-12 is a Sunday.
    const out = buildBaselineTrendFeatures([
      row({ date: '2026-04-12', campaign_id: 'c-S', impressions: 100, clicks: 10, cost: 20, conversions: 1, conversion_value: 40 }),
    ])
    expect(out[0]!['weekday']).toBe(6)
  })

  it('preserves input column order, then appends derived columns', () => {
    // Build rows with explicit key order to assert column preservation.
    const inputRows = [
      { date: '2026-04-12', company: 'Apice', campaign_id: 'c-O', impressions: 100, clicks: 10, cost: 20, conversions: 1, conversion_value: 40 },
      { date: '2026-04-13', company: 'Apice', campaign_id: 'c-O', impressions: 100, clicks: 10, cost: 20, conversions: 1, conversion_value: 40 },
    ]
    const out = buildBaselineTrendFeatures(inputRows as unknown as RawRow[])
    const keys = Object.keys(out[0]!)
    // Input columns appear first in original (insertion) order.
    expect(keys.slice(0, 8)).toEqual([
      'date',
      'company',
      'campaign_id',
      'impressions',
      'clicks',
      'cost',
      'conversions',
      'conversion_value',
    ])
    // Derived columns appear afterwards.
    expect(keys).toContain('ctr')
    expect(keys).toContain('roas_28d')
    expect(keys).toContain('ewma_roas')
    expect(keys[keys.length - 1]).toBe('trend_status')
  })

  it('classify_trend thresholds: strong_positive/positive/normal/negative/strong_negative', () => {
    // Build sequence so that on day 8 we have roas_28d ≈ 1.0 (cost=conversion_value over prior days)
    // and current-day roas varies to trigger each class.
    const baseDays = 28
    const rows: RawRow[] = []
    for (let i = 0; i < baseDays; i++) {
      const d = new Date(Date.UTC(2026, 3, 12) + i * 86_400_000).toISOString().slice(0, 10)
      rows.push(row({ date: d, campaign_id: 'c-T', impressions: 1000, clicks: 100, cost: 100, conversions: 5, conversion_value: 100 }))
    }
    // day 29 has roas vs 1.0 baseline
    function pushDay(roas: number) {
      const d = new Date(Date.UTC(2026, 3, 12) + baseDays * 86_400_000).toISOString().slice(0, 10)
      rows.length = baseDays
      rows.push(row({ date: d, campaign_id: 'c-T', impressions: 1000, clicks: 100, cost: 100, conversions: 5, conversion_value: 100 * roas }))
    }

    pushDay(1.4) // > 1.35 → strong_positive
    let out = buildBaselineTrendFeatures([...rows])
    expect(out[out.length - 1]!['trend_status']).toBe('strong_positive')

    pushDay(1.25) // 1.2 < 1.25 < 1.35 → positive
    out = buildBaselineTrendFeatures([...rows])
    expect(out[out.length - 1]!['trend_status']).toBe('positive')

    pushDay(1.0) // normal
    out = buildBaselineTrendFeatures([...rows])
    expect(out[out.length - 1]!['trend_status']).toBe('normal')

    pushDay(0.75) // 0.65 < 0.75 < 0.8 → negative
    out = buildBaselineTrendFeatures([...rows])
    expect(out[out.length - 1]!['trend_status']).toBe('negative')

    pushDay(0.5) // < 0.65 → strong_negative
    out = buildBaselineTrendFeatures([...rows])
    expect(out[out.length - 1]!['trend_status']).toBe('strong_negative')
  })
})
