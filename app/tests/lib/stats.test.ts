import { describe, it, expect } from 'vitest'
import { mean, median, mad, ewma, olsSlope, qcutRanks } from '@/lib/stats'

describe('stats', () => {
  it('mean ignores null/NaN', () => {
    expect(mean([1, 2, 3, null, NaN])).toBeCloseTo(2, 12)
  })

  it('median odd & even', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })

  it('mad = median absolute deviation', () => {
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1)
  })

  it('ewma matches pandas .ewm(alpha=0.4, adjust=False)', () => {
    // values: [10, 12, 14], alpha=0.4
    // s0=10; s1=0.4*12+0.6*10=10.8; s2=0.4*14+0.6*10.8=12.08
    const out = ewma([10, 12, 14], 0.4)
    expect(out[0]).toBeCloseTo(10, 12)
    expect(out[1]!).toBeCloseTo(10.8, 12)
    expect(out[2]!).toBeCloseTo(12.08, 12)
  })

  it('olsSlope returns slope of log(y) = a + b·log(x)', () => {
    const x = [1, 2, 4, 8]
    const y = [2, 4, 8, 16]
    // log-log slope should be ~1
    const slope = olsSlope(x.map(Math.log), y.map(Math.log))
    expect(slope).toBeCloseTo(1, 10)
  })

  it('qcutRanks equal-count bucketing (pandas qcut on rank)', () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80]
    // 4 bands → [1,1,2,2,3,3,4,4]
    expect(qcutRanks(vals, 4)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })
})
