// src/core/errors.ts

/** Base class for all GoTrends domain errors. Tagged with a stable `code`. */
export class GoTrendsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'GoTrendsError'
  }
}

/** Raised when a candidate recommendation fails CandidateSchema validation. */
export class CandidateInvalid extends GoTrendsError {
  constructor(detail: string) {
    super('CANDIDATE_INVALID', detail)
    this.name = 'CandidateInvalid'
  }
}

/** Raised when a refined recommendation fails RecommendationSchema validation. */
export class RecommendationSchemaViolation extends GoTrendsError {
  constructor(detail: string) {
    super('RECOMMENDATION_SCHEMA_VIOLATION', detail)
    this.name = 'RecommendationSchemaViolation'
  }
}

/** Raised when a guardrail decisively blocks an action. */
export class GuardrailBlocked extends GoTrendsError {
  constructor(public readonly reason: string) {
    super('GUARDRAIL_BLOCKED', reason)
    this.name = 'GuardrailBlocked'
  }
}

/** Raised when a parity comparison (Python ↔ TS) finds a divergence above tolerance. */
export class ParityViolation extends GoTrendsError {
  constructor(
    public readonly field: string,
    public readonly actual: unknown,
    public readonly expected: unknown,
  ) {
    super('PARITY_VIOLATION', `${field}: actual=${String(actual)} expected=${String(expected)}`)
    this.name = 'ParityViolation'
  }
}
