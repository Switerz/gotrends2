import { describe, it, expect } from 'vitest'
import { OUTCOME_WINDOWS, type OutcomeWindow } from '@/core/types'
import {
  PARITY_TOLERANCE,
  RECOMMENDATION_TTL_HOURS,
  MAX_ABS_CHANGE_PERCENT,
  CONFIDENCE_REVIEW_THRESHOLD,
} from '@/core/constants'

describe('core types/constants', () => {
  it('OUTCOME_WINDOWS is a stable triple', () => {
    expect(OUTCOME_WINDOWS).toEqual(['24h', '72h', '7d'])
  })

  it('OutcomeWindow type-narrows correctly (compile-time guard via runtime usage)', () => {
    const w: OutcomeWindow = '24h'
    expect(w).toBe('24h')
  })

  it('parity tolerance is 1e-6', () => {
    expect(PARITY_TOLERANCE).toBe(1e-6)
  })

  it('TTL, max-change, and confidence thresholds are exposed', () => {
    expect(RECOMMENDATION_TTL_HOURS).toBe(24)
    expect(MAX_ABS_CHANGE_PERCENT).toBe(0.5)
    expect(CONFIDENCE_REVIEW_THRESHOLD).toBe(40)
  })
})
