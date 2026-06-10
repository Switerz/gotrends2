import { describe, it, expect } from 'vitest'
import {
  addRobustAnomalyFlags,
  robustZScore,
  DEFAULT_METRICS,
} from '@/models/anomalyDetection'

type Row = Record<string, unknown>

function dayRow(date: string, overrides: Partial<Row> = {}): Row {
  return {
    company: 'X',
    campaign_id: 'c1',
    date,
    cpc: 1, ctr: 0.05, cvr: 0.1, roas: 5, cost: 100, conversions: 10,
    ...overrides,
  }
}

function seriesDays(n: number, base: (i: number) => Partial<Row>): Row[] {
  const out: Row[] = []
  const start = new Date('2026-01-01T00:00:00Z').getTime()
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    out.push(dayRow(d, base(i)))
  }
  return out
}

describe('addRobustAnomalyFlags edge cases', () => {
  it('empty input returns []', () => {
    expect(addRobustAnomalyFlags([])).toEqual([])
  })

  it('single row → no history → z null and flags false', () => {
    const out = addRobustAnomalyFlags([dayRow('2026-01-01')])
    expect(out).toHaveLength(1)
    const r = out[0]!
    for (const m of DEFAULT_METRICS) {
      expect(r[`${m}_robust_z`]).toBeNull()
      expect(r[`${m}_anomaly`]).toBe(false)
    }
    expect(r.anomaly_count).toBe(0)
    expect(r.critical_anomaly_block).toBe(false)
  })

  it('all-identical metric values → MAD = 0 → z is null (matches Python NaN)', () => {
    // 10 days of identical values; on day 11 use same value → MAD=0 → z = NaN/null
    const rows = seriesDays(11, () => ({ roas: 5 }))
    const out = addRobustAnomalyFlags(rows)
    const lastIdx = out.findIndex(r => r.date === rows[10]!.date)
    expect(out[lastIdx]!.roas_robust_z).toBeNull()
    expect(out[lastIdx]!.roas_anomaly).toBe(false)
  })

  it('history with only nulls in a metric → z is null for that metric', () => {
    // 10 days with roas null, then day 11 has roas=5 (window has no usable values)
    const rows = seriesDays(11, i => (i < 10 ? { roas: null } : { roas: 5 }))
    const out = addRobustAnomalyFlags(rows)
    const last = out.find(r => r.date === rows[10]!.date)!
    expect(last.roas_robust_z).toBeNull()
    expect(last.roas_anomaly).toBe(false)
  })

  it('critical_anomaly_block triggers on roas|cost|conversions OR; ignores cpc/ctr/cvr', () => {
    // Build 10 baseline days with jitter (so MAD > 0), then a giant outlier in cost only
    const baseline = seriesDays(10, i => ({ cost: 100 + (i % 3) * 0.5 }))
    const start = new Date('2026-01-01T00:00:00Z').getTime()
    const outlierDate = new Date(start + 10 * 86_400_000).toISOString().slice(0, 10)
    const outlier = dayRow(outlierDate, { cost: 10_000 })
    const out = addRobustAnomalyFlags([...baseline, outlier])
    const last = out.find(r => r.date === outlierDate)!
    expect(last.cost_anomaly).toBe(true)
    expect(last.critical_anomaly_block).toBe(true)

    // Non-critical outlier on ctr only — critical_anomaly_block must stay false
    const baseline2 = seriesDays(10, i => ({ ctr: 0.05 + (i % 3) * 0.0005 }))
    const outlier2 = dayRow(outlierDate, { ctr: 10 })
    const out2 = addRobustAnomalyFlags([...baseline2, outlier2])
    const last2 = out2.find(r => r.date === outlierDate)!
    expect(last2.ctr_anomaly).toBe(true)
    expect(last2.critical_anomaly_block).toBe(false)
  })

  it('30-day series with a sharp outlier on day 30 → flagged on that day', () => {
    const start = new Date('2026-02-01T00:00:00Z').getTime()
    const rows: Row[] = []
    for (let i = 0; i < 30; i++) {
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
      // small jitter so MAD > 0
      rows.push(dayRow(d, { roas: 5 + (i % 3) * 0.01 }))
    }
    // sharp roas outlier on day 30 (index 29)
    rows[29]!['roas'] = 500
    const out = addRobustAnomalyFlags(rows)
    const last = out.find(r => r.date === rows[29]!.date)!
    expect(last.roas_anomaly).toBe(true)
    expect(typeof last.roas_robust_z === 'number' && Math.abs(last.roas_robust_z) >= 3.5).toBe(true)
    expect(last.critical_anomaly_block).toBe(true)
    expect(last.anomaly_count).toBeGreaterThanOrEqual(1)
  })

  it('groups are isolated: outlier in one campaign does not affect another', () => {
    const start = new Date('2026-01-01T00:00:00Z').getTime()
    const day11 = new Date(start + 10 * 86_400_000).toISOString().slice(0, 10)
    // Both groups have jittered baselines so MAD > 0
    const a = seriesDays(10, i => ({ roas: 5 + (i % 3) * 0.01 }))
    const b: Row[] = seriesDays(10, i => ({ roas: 5 + (i % 3) * 0.01 })).map(r => ({ ...r, campaign_id: 'c2' }))
    const aOutlier = dayRow(day11, { roas: 500 })
    const bNormal = dayRow(day11, { roas: 5.01, campaign_id: 'c2' })
    const out = addRobustAnomalyFlags([...a, ...b, aOutlier, bNormal])
    const aLast = out.find(r => r.campaign_id === 'c1' && r.date === day11)!
    const bLast = out.find(r => r.campaign_id === 'c2' && r.date === day11)!
    expect(aLast.roas_anomaly).toBe(true)
    expect(bLast.roas_anomaly).toBe(false)
  })
})

describe('robustZScore', () => {
  it('returns NaN for empty history', () => {
    expect(Number.isNaN(robustZScore(5, []))).toBe(true)
  })

  it('returns NaN when mad is 0', () => {
    expect(Number.isNaN(robustZScore(5, [3, 3, 3, 3, 3]))).toBe(true)
  })

  it('computes correct value', () => {
    const z = robustZScore(10, [1, 2, 3, 4, 5])
    // median=3, mad=median(|x-3|) = median([2,1,0,1,2]) = 1, z = 0.6745*(10-3)/1
    expect(z).toBeCloseTo(0.6745 * 7, 9)
  })
})
