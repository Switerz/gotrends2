// src/core/constants.ts

/** Parity tolerance for Python ↔ TS model output comparison. */
export const PARITY_TOLERANCE = 1e-6

/** Default expiration for a pending recommendation (hours). */
export const RECOMMENDATION_TTL_HOURS = 24

/** Hard limit on a single recommendation's change_percent magnitude. */
export const MAX_ABS_CHANGE_PERCENT = 0.5

/** Confidence score threshold below which a recommendation goes to human review. */
export const CONFIDENCE_REVIEW_THRESHOLD = 40
