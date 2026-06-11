// tests/db/rowMapper.test.ts
//
// mapRow must transparently handle BOTH row shapes the Godeploy DB binding
// can hand us:
//   - Array form (better-sqlite3, local dev)
//   - Object form (live Godeploy Worker runtime)

import { describe, it, expect } from 'vitest'
import { mapRow, mapRows } from '@/db/rowMapper'

describe('mapRow', () => {
  it('handles array-form rows', () => {
    expect(mapRow<{ a: number; b: string }>(['a', 'b'], [1, 'x'])).toEqual({ a: 1, b: 'x' })
  })

  it('handles object-form rows', () => {
    expect(mapRow<{ a: number; b: string }>(['a', 'b'], { a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' })
  })

  it('object form picks only requested columns', () => {
    expect(mapRow<{ a: number }>(['a'], { a: 1, b: 'x' })).toEqual({ a: 1 })
  })

  it('array form fills undefined for short arrays', () => {
    expect(mapRow<{ a: number; b: string | undefined }>(['a', 'b'], [1])).toEqual({
      a: 1,
      b: undefined,
    })
  })

  it('null values pass through (array form)', () => {
    expect(mapRow<{ a: string | null }>(['a'], [null])).toEqual({ a: null })
  })

  it('null values pass through (object form)', () => {
    expect(mapRow<{ a: string | null }>(['a'], { a: null })).toEqual({ a: null })
  })
})

describe('mapRows', () => {
  it('handles mixed-shape inputs (defensive)', () => {
    const out = mapRows<{ x: number }>(
      ['x'],
      [[1], { x: 2 }, [3]],
    )
    expect(out).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }])
  })

  it('handles an all-object batch (live Worker shape)', () => {
    const out = mapRows<{ account_id: string; is_active: number }>(
      ['account_id', 'is_active'],
      [
        { account_id: '7705857660', is_active: 1 },
        { account_id: '7705857661', is_active: 1 },
      ],
    )
    expect(out).toEqual([
      { account_id: '7705857660', is_active: 1 },
      { account_id: '7705857661', is_active: 1 },
    ])
  })

  it('handles an all-array batch (local dev shape)', () => {
    const out = mapRows<{ account_id: string; is_active: number }>(
      ['account_id', 'is_active'],
      [
        ['7705857660', 1],
        ['7705857661', 1],
      ],
    )
    expect(out).toEqual([
      { account_id: '7705857660', is_active: 1 },
      { account_id: '7705857661', is_active: 1 },
    ])
  })
})
