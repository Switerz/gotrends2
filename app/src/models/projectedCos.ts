/**
 * Projected COS (Cost of Sales) helpers — TS port of legacy/python/models/projected_cos.py.
 *
 * Parity contract:
 *   projected_cos(current_media_cost, current_revenue, delta_media_cost, expected_incremental_revenue)
 *     = (current_media_cost + delta_media_cost) / (current_revenue + expected_incremental_revenue)
 *     returns np.nan when denominator == 0 (mapped here to null)
 *
 *   cos_status(value, limit=0.15)
 *     - NaN/null         -> "needs_human_review"
 *     - value <= limit   -> "allowed"
 *     - value  > limit   -> "blocked"
 */

export const DEFAULT_COS_LIMIT = 0.15

/** Numeric input that may be missing (null/undefined) or NaN. */
type NumIn = number | null | undefined

function isMissing(x: NumIn): boolean {
  return x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))
}

/**
 * Compute projected cost of sales after a proposed media change.
 * Returns null when the denominator is zero or any input is missing — mirrors Python's np.nan.
 */
export function projectedCos(
  currentMediaCost: NumIn,
  currentRevenue: NumIn,
  deltaMediaCost: NumIn,
  expectedIncrementalRevenue: NumIn,
): number | null {
  if (
    isMissing(currentMediaCost) ||
    isMissing(currentRevenue) ||
    isMissing(deltaMediaCost) ||
    isMissing(expectedIncrementalRevenue)
  ) {
    return null
  }
  const denominator = (currentRevenue as number) + (expectedIncrementalRevenue as number)
  if (denominator === 0) return null
  return ((currentMediaCost as number) + (deltaMediaCost as number)) / denominator
}

/**
 * Classify a projected COS value against a limit (default 0.15).
 *   null/NaN -> "needs_human_review"
 *   <= limit -> "allowed"
 *   >  limit -> "blocked"
 */
export function cosStatus(value: number | null | undefined, limit: number = DEFAULT_COS_LIMIT): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'needs_human_review'
  }
  return value <= limit ? 'allowed' : 'blocked'
}
