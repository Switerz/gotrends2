import { describe, it, expect } from 'vitest'
import {
  GoTrendsError,
  CandidateInvalid,
  RecommendationSchemaViolation,
  GuardrailBlocked,
  ParityViolation,
} from '@/core/errors'

describe('core errors', () => {
  it('GoTrendsError carries a stable code and name', () => {
    const e = new GoTrendsError('SOME_CODE', 'msg')
    expect(e.code).toBe('SOME_CODE')
    expect(e.name).toBe('GoTrendsError')
    expect(e.message).toBe('msg')
    expect(e).toBeInstanceOf(Error)
  })

  it('CandidateInvalid has code CANDIDATE_INVALID and instanceof GoTrendsError', () => {
    const e = new CandidateInvalid('bad shape')
    expect(e.code).toBe('CANDIDATE_INVALID')
    expect(e).toBeInstanceOf(GoTrendsError)
  })

  it('GuardrailBlocked exposes reason', () => {
    const e = new GuardrailBlocked('manual_pause_active')
    expect(e.code).toBe('GUARDRAIL_BLOCKED')
    expect(e.reason).toBe('manual_pause_active')
  })

  it('ParityViolation builds an informative message and keeps fields', () => {
    const e = new ParityViolation('roas', 1.2, 1.3)
    expect(e.code).toBe('PARITY_VIOLATION')
    expect(e.field).toBe('roas')
    expect(e.actual).toBe(1.2)
    expect(e.expected).toBe(1.3)
    expect(e.message).toContain('roas')
    expect(e.message).toContain('1.2')
    expect(e.message).toContain('1.3')
  })

  it('RecommendationSchemaViolation tags correctly', () => {
    const e = new RecommendationSchemaViolation('detail')
    expect(e.code).toBe('RECOMMENDATION_SCHEMA_VIOLATION')
  })
})
