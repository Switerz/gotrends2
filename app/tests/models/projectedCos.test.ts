import { describe, it, expect } from 'vitest'
import { projectedCos, cosStatus, DEFAULT_COS_LIMIT } from '@/models/projectedCos'

describe('projectedCos', () => {
  it('returns null when denominator (current_revenue + expected_incremental_revenue) is exactly zero', () => {
    expect(projectedCos(1000, 0, 500, 0)).toBeNull()
    expect(projectedCos(1000, 100, 500, -100)).toBeNull()
  })

  it('zero delta_media_cost and zero expected_incremental_revenue -> current_media_cost / current_revenue', () => {
    expect(projectedCos(10000, 80000, 0, 0)).toBeCloseTo(0.125, 12)
  })

  it('negative expected_incremental_revenue still computes when denominator non-zero', () => {
    // 80000 + (-5000) = 75000 denominator, 10000+2000 = 12000 numerator -> 0.16
    expect(projectedCos(10000, 80000, 2000, -5000)).toBeCloseTo(0.16, 12)
  })

  it('negative delta_media_cost is allowed (e.g., cutting spend)', () => {
    // (10000 - 2000) / (80000 + 0) = 0.1
    expect(projectedCos(10000, 80000, -2000, 0)).toBeCloseTo(0.1, 12)
  })

  it('any null/undefined input -> null', () => {
    expect(projectedCos(null, 80000, 100, 100)).toBeNull()
    expect(projectedCos(10000, null, 100, 100)).toBeNull()
    expect(projectedCos(10000, 80000, null, 100)).toBeNull()
    expect(projectedCos(10000, 80000, 100, null)).toBeNull()
    expect(projectedCos(undefined, 80000, 100, 100)).toBeNull()
  })

  it('NaN input -> null (treated as missing)', () => {
    expect(projectedCos(NaN, 80000, 100, 100)).toBeNull()
    expect(projectedCos(10000, NaN, 100, 100)).toBeNull()
  })

  it('very large positive delta_media_cost yields large COS', () => {
    // (10000 + 50000) / (80000 + 1000) = 60000 / 81000
    const v = projectedCos(10000, 80000, 50000, 1000)
    expect(v).not.toBeNull()
    expect(v as number).toBeCloseTo(60000 / 81000, 12)
    expect(cosStatus(v)).toBe('blocked')
  })
})

describe('cosStatus', () => {
  it('null -> needs_human_review', () => {
    expect(cosStatus(null)).toBe('needs_human_review')
  })

  it('NaN -> needs_human_review', () => {
    expect(cosStatus(Number.NaN)).toBe('needs_human_review')
  })

  it('undefined -> needs_human_review', () => {
    expect(cosStatus(undefined)).toBe('needs_human_review')
  })

  it('value < default limit -> allowed', () => {
    expect(cosStatus(0.1)).toBe('allowed')
    expect(cosStatus(0)).toBe('allowed')
  })

  it('value exactly at default limit (0.15) -> allowed (<= boundary)', () => {
    expect(cosStatus(0.15)).toBe('allowed')
    expect(cosStatus(DEFAULT_COS_LIMIT)).toBe('allowed')
  })

  it('value just above default limit -> blocked', () => {
    expect(cosStatus(0.15 + 1e-9)).toBe('blocked')
    expect(cosStatus(0.18518518518518517)).toBe('blocked')
  })

  it('respects custom strict limit', () => {
    // 0.125 with limit 0.10 -> blocked
    expect(cosStatus(0.125, 0.1)).toBe('blocked')
    // boundary at custom limit -> allowed
    expect(cosStatus(0.1, 0.1)).toBe('allowed')
  })

  it('default limit constant equals 0.15 (Python default)', () => {
    expect(DEFAULT_COS_LIMIT).toBe(0.15)
  })
})
