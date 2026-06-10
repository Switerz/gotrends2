import { describe, it, expect } from 'vitest'
import { groupBy, sortBy, leftJoin, rollingSumPriorOnly } from '@/lib/df'

describe('df', () => {
  it('groupBy by composite key', () => {
    const rows = [
      { co: 'A', cid: 1, v: 10 },
      { co: 'A', cid: 1, v: 20 },
      { co: 'A', cid: 2, v: 30 },
      { co: 'B', cid: 1, v: 40 },
    ]
    const g = groupBy(rows, r => `${r.co}|${r.cid}`)
    expect(g.size).toBe(3)
    expect(g.get('A|1')!.length).toBe(2)
  })

  it('sortBy ascending by key', () => {
    const rows = [{ d: '2026-01-03' }, { d: '2026-01-01' }, { d: '2026-01-02' }]
    expect(sortBy(rows, r => r.d).map(r => r.d))
      .toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
  })

  it('leftJoin matches and preserves left order', () => {
    const left = [{ k: 1, a: 'x' }, { k: 2, a: 'y' }]
    const right = [{ k: 2, b: 'B' }, { k: 1, b: 'A' }]
    const joined = leftJoin(left, right, l => `${l.k}`, r => `${r.k}`)
    expect(joined).toEqual([
      { k: 1, a: 'x', b: 'A' },
      { k: 2, a: 'y', b: 'B' },
    ])
  })

  it('rollingSumPriorOnly excludes current row (shift(1).rolling(window).sum)', () => {
    // matches pandas: s.shift(1).rolling(3, min_periods=1).sum()
    expect(rollingSumPriorOnly([10, 20, 30, 40, 50], 3))
      .toEqual([0, 10, 30, 60, 90])
  })
})
