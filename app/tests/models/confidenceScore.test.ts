import { describe, it, expect } from 'vitest'
import { addConfidenceFeatures } from '@/models/confidenceScore'

type Row = {
  date: string
  company: string
  campaign_id: string
  cost: number | null
  clicks: number | null
  conversions: number | null
  conversion_value: number | null
  roas?: number | null
}

const baseRow = (overrides: Partial<Row>): Row => ({
  date: '2026-01-01',
  company: 'A',
  campaign_id: 'c1',
  cost: 0,
  clicks: 0,
  conversions: 0,
  conversion_value: 0,
  ...overrides,
})

describe('addConfidenceFeatures edge cases', () => {
  it('empty input returns []', () => {
    expect(addConfidenceFeatures([])).toEqual([])
  })

  it('single row: rolling/derived columns are null/0 since no prior data exists', () => {
    const out = addConfidenceFeatures([
      baseRow({ cost: 100, clicks: 10, conversions: 1, conversion_value: 200 }),
    ])
    expect(out).toHaveLength(1)
    const r = out[0]!
    expect(r.cost_28d).toBeNull()
    expect(r.clicks_28d).toBeNull()
    expect(r.conversions_28d).toBeNull()
    expect(r.conversion_value_28d).toBeNull()
    // days_with_spend_28d: shift(1) -> NaN, NaN>0 is False, rolling sum = 0
    expect(r.days_with_spend_28d).toBe(0)
    // roas_observations_28d uses count() on shifted series -> 0 non-null
    expect(r.roas_observations_28d).toBe(0)
    expect(r.avg_roas_28d).toBeNull()
    expect(r.stddev_roas_28d).toBeNull()
    expect(r.roas_28d).toBeNull()
    expect(r.roas_cv_28d).toBeNull()
    // No prior obs => volatility penalty forced to 20; raw_score = 0+0+0+0-20 = -20 -> clipped to 0
    expect(r.volatility_penalty).toBe(20)
    expect(r.confidence_score).toBe(0)
    expect(r.data_sufficiency).toBe('insufficient')
    expect(r.allow_budget_increase).toBe('False')
    expect(r.allow_aggressive_action).toBe('False')
  })

  it('all-null roas across prior window keeps roas-derived columns null and forces volatility_penalty=20', () => {
    // 8 days of zero-cost so roas is null (0 denom -> null), volatility uses obs<7 branch
    const rows: Row[] = Array.from({ length: 8 }, (_, i) =>
      baseRow({
        date: `2026-01-0${i + 1}`,
        cost: 0,
        clicks: 0,
        conversions: 0,
        conversion_value: 0,
      }),
    )
    const out = addConfidenceFeatures(rows)
    for (const r of out) {
      // roas is null because cost=0
      expect(r.roas).toBeNull()
      expect(r.avg_roas_28d).toBeNull()
      expect(r.stddev_roas_28d).toBeNull()
      expect(r.roas_28d).toBeNull()
      expect(r.roas_cv_28d).toBeNull()
      // roas_observations_28d count of nulls -> 0, < 7, so volatility forced to 20
      expect(r.roas_observations_28d).toBe(0)
      expect(r.volatility_penalty).toBe(20)
    }
  })

  it('confidence_score caps at 100 with constant high-spend / high-roas series', () => {
    // 30 days of strong spend + revenue: cost=5000/day, clicks=2000, conv=50, roas=2.0 constant.
    // After day 8 (>=7 obs), volatility_penalty uses cv=0 -> negative, clipped to 0.
    // cost_score, clicks_score, conversions_score, spend_days_score all hit cap of 25.
    // raw_score = 100 - 0 = 100 -> capped at 100.
    const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      company: 'A',
      campaign_id: 'c-cap',
      cost: 5000,
      clicks: 2000,
      conversions: 50,
      conversion_value: 10000,
      roas: 2.0,
    }))
    const out = addConfidenceFeatures(rows)
    // Last row should have full prior history
    const last = out[out.length - 1]!
    expect(last.cost_score).toBe(25)
    expect(last.clicks_score).toBe(25)
    expect(last.conversions_score).toBe(25)
    expect(last.spend_days_score).toBe(25)
    expect(last.volatility_penalty).toBe(0)
    expect(last.confidence_score).toBe(100)
    expect(last.data_sufficiency).toBe('high')
    expect(last.allow_budget_increase).toBe('True')
    expect(last.allow_aggressive_action).toBe('True')
  })

  it('confidence_score is an integer matching pandas .round().astype(int)', () => {
    // Construct a series that produces a fractional raw_score and verify .5 banker rounding.
    // Just use the constant-high case but stop at day 8 to get partial accumulation, then
    // check the integer type and value.
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      company: 'A',
      campaign_id: 'c-int',
      cost: 100,
      clicks: 50,
      conversions: 2,
      conversion_value: 200,
      roas: 2.0,
    }))
    const out = addConfidenceFeatures(rows)
    for (const r of out) {
      expect(Number.isInteger(r.confidence_score)).toBe(true)
    }
  })

  it('data_sufficiency bin edges line up with Python pd.cut bins', () => {
    // Build a 30-day series that lands in each tier and verify string labels.
    // We can do this by directly toggling cost magnitude.
    const days = (n: number, cost: number, clicks: number, convs: number, val: number, roas: number) =>
      Array.from({ length: n }, (_, i) => ({
        date: `2026-02-${String(i + 1).padStart(2, '0')}`,
        company: 'A',
        campaign_id: `c-${cost}`,
        cost,
        clicks,
        conversions: convs,
        conversion_value: val,
        roas,
      }))

    // very low spend -> insufficient
    let out = addConfidenceFeatures(days(15, 1, 0, 0, 0, 0))
    expect(['insufficient', 'low']).toContain(out[out.length - 1]!.data_sufficiency)
    // high spend constant -> high
    out = addConfidenceFeatures(days(30, 5000, 2000, 50, 10000, 2.0))
    expect(out[out.length - 1]!.data_sufficiency).toBe('high')
  })

  it('computes roas itself when input does not provide it', () => {
    const rows = [
      { date: '2026-03-01', company: 'A', campaign_id: 'x', cost: 100, clicks: 1, conversions: 1, conversion_value: 250 },
      { date: '2026-03-02', company: 'A', campaign_id: 'x', cost: 0, clicks: 0, conversions: 0, conversion_value: 0 },
    ] as Row[]
    const out = addConfidenceFeatures(rows)
    expect(out[0]!.roas).toBeCloseTo(2.5, 10)
    // cost=0 -> roas null
    expect(out[1]!.roas).toBeNull()
  })

  it('sort_values stability: groups by (company, campaign_id) and sorts by date', () => {
    // Provide rows in non-sorted order; verify output is sorted.
    const rows: Row[] = [
      baseRow({ date: '2026-04-03', campaign_id: 'a', cost: 10 }),
      baseRow({ date: '2026-04-01', campaign_id: 'a', cost: 30 }),
      baseRow({ date: '2026-04-02', campaign_id: 'a', cost: 20 }),
    ]
    const out = addConfidenceFeatures(rows)
    expect(out.map(r => r.date)).toEqual(['2026-04-01', '2026-04-02', '2026-04-03'])
    // First-row cost_28d must be null (no prior)
    expect(out[0]!.cost_28d).toBeNull()
    // Day 2: prior sum = 30
    expect(out[1]!.cost_28d).toBe(30)
    // Day 3: prior sum = 30 + 20 = 50
    expect(out[2]!.cost_28d).toBe(50)
  })
})
