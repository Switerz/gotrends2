/**
 * Lever diagnosis rules for GoTrends v2.
 *
 * Port of legacy/python/models/lever_diagnosis.py with 1e-6 parity.
 *
 * Adds two derived columns to each enriched campaign row:
 *  - primary_constraint: classification of the dominant operational constraint
 *  - recommended_action: initial action suggested for that constraint, taking
 *    saturation + confidence + budget-block state into account.
 *
 * Inputs expected on each row (when present, otherwise null/undefined):
 *  - current_roas, proxy_target_roas, marginal_roas
 *  - impression_share, lost_is_budget
 *  - ctr, cvr, campaign_type_avg_ctr, campaign_type_avg_cvr
 *  - confidence_score, saturation_level, pure_budget_increase_blocked
 */

export interface LeverConfig {
  /** Minimum confidence_score (0-100) required to recommend any active lever. */
  minConfidenceForAction: number
}

export const DEFAULT_LEVER_CONFIG: LeverConfig = {
  minConfidenceForAction: 60,
}

export type PrimaryConstraint =
  | 'saturated'
  | 'budget_limited'
  | 'scale_opportunity'
  | 'low_efficiency'
  | 'relevance_issue'
  | 'post_click_issue'
  | 'monitor'

export type LeverRecommendedAction =
  | 'monitor'
  | 'optimize_efficiency'
  | 'increase_budget'
  | 'increase_troas_or_reduce_budget'
  | 'improve_ads_or_terms'
  | 'review_landing_or_offer'

export interface LeverInputRow {
  current_roas?: number | null
  proxy_target_roas?: number | null
  marginal_roas?: number | null
  impression_share?: number | null
  lost_is_budget?: number | null
  ctr?: number | null
  cvr?: number | null
  campaign_type_avg_ctr?: number | null
  campaign_type_avg_cvr?: number | null
  confidence_score?: number | null
  saturation_level?: string | null
  pure_budget_increase_blocked?: boolean | string | null
  [key: string]: unknown
}

export interface LeverOutputRow extends LeverInputRow {
  primary_constraint: PrimaryConstraint
  recommended_action: LeverRecommendedAction
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** pandas.notna(): true for finite numbers, false for null/undefined/NaN. */
function notNa(v: unknown): v is number {
  return isNum(v)
}

/**
 * Classify the main operational constraint for a campaign.
 *
 * Branch order matches the Python `diagnose_primary_constraint` exactly:
 *   1. roas_good AND impression_share >= 0.90  → 'saturated'
 *   2. roas_good AND lost_is_budget   > 0.05   → 'budget_limited'
 *   3. roas_good AND marginal_good              → 'scale_opportunity'
 *   4. NOT roas_good (both roas signals known)  → 'low_efficiency'
 *   5. ctr <  0.70 * avg_ctr                    → 'relevance_issue'
 *   6. cvr <  0.70 * avg_cvr                    → 'post_click_issue'
 *   7. fallthrough                              → 'monitor'
 */
export function diagnosePrimaryConstraint(row: LeverInputRow): PrimaryConstraint {
  const currentRoas = row.current_roas
  const proxyTargetRoas = row.proxy_target_roas
  const marginalRoas = row.marginal_roas
  const impressionShare = row.impression_share
  const lostIsBudget = row.lost_is_budget
  const ctr = row.ctr
  const cvr = row.cvr
  const avgCtr = row.campaign_type_avg_ctr
  const avgCvr = row.campaign_type_avg_cvr

  const roasGood =
    notNa(currentRoas) && notNa(proxyTargetRoas) && currentRoas >= proxyTargetRoas
  const marginalGood =
    notNa(marginalRoas) && notNa(proxyTargetRoas) && marginalRoas >= proxyTargetRoas

  if (roasGood && notNa(impressionShare) && impressionShare >= 0.9) {
    return 'saturated'
  }
  if (roasGood && notNa(lostIsBudget) && lostIsBudget > 0.05) {
    return 'budget_limited'
  }
  if (roasGood && marginalGood) {
    return 'scale_opportunity'
  }
  if (!roasGood && notNa(currentRoas) && notNa(proxyTargetRoas)) {
    return 'low_efficiency'
  }
  if (notNa(ctr) && notNa(avgCtr) && ctr < avgCtr * 0.7) {
    return 'relevance_issue'
  }
  if (notNa(cvr) && notNa(avgCvr) && cvr < avgCvr * 0.7) {
    return 'post_click_issue'
  }
  return 'monitor'
}

/**
 * Return an initial recommended action based on diagnosis and confidence.
 *
 * Branch order matches the Python `recommend_action` exactly:
 *   1. confidence < 40 → 'monitor'
 *   2. budget-block AND (budget_limited or scale_opportunity) → 'optimize_efficiency'
 *   3. (budget_limited or scale_opportunity) AND saturation in {low,moderate}
 *      AND confidence >= min                                  → 'increase_budget'
 *   4. (efficiency_risk or low_efficiency) AND confidence >= min
 *                                                              → 'increase_troas_or_reduce_budget'
 *   5. saturated                                               → 'optimize_efficiency'
 *   6. relevance_issue                                         → 'improve_ads_or_terms'
 *   7. post_click_issue                                        → 'review_landing_or_offer'
 *   8. fallthrough                                             → 'monitor'
 *
 * The Python `bool(row.get(...))` semantics are preserved: any truthy value
 * (true, non-empty string except 'False'…) counts as blocked. We accept either
 * a JS boolean or the pandas-CSV strings 'True'/'False'.
 */
export function recommendAction(
  row: LeverInputRow & {
    primary_constraint?: PrimaryConstraint | string | null
  },
  config: LeverConfig = DEFAULT_LEVER_CONFIG,
): LeverRecommendedAction {
  // Python: row.get('confidence_score', 0)
  const confidenceRaw = row.confidence_score
  const confidence = isNum(confidenceRaw) ? confidenceRaw : 0
  const primaryConstraint = row.primary_constraint ?? null
  const saturationLevel = row.saturation_level ?? null

  const pbib = row.pure_budget_increase_blocked
  // Mirror bool(...) in Python: only treat the pandas-CSV literal 'False' as
  // falsy when given a string; everything else follows JS-boolean truthiness.
  const pureBudgetBlocked =
    typeof pbib === 'string' ? pbib === 'True' : Boolean(pbib)

  if (confidence < 40) return 'monitor'

  const scalable =
    primaryConstraint === 'budget_limited' || primaryConstraint === 'scale_opportunity'
  if (pureBudgetBlocked && scalable) return 'optimize_efficiency'

  if (
    scalable &&
    (saturationLevel === 'low' || saturationLevel === 'moderate') &&
    confidence >= config.minConfidenceForAction
  ) {
    return 'increase_budget'
  }

  const inefficient =
    primaryConstraint === 'efficiency_risk' || primaryConstraint === 'low_efficiency'
  if (inefficient && confidence >= config.minConfidenceForAction) {
    return 'increase_troas_or_reduce_budget'
  }

  if (primaryConstraint === 'saturated') return 'optimize_efficiency'
  if (primaryConstraint === 'relevance_issue') return 'improve_ads_or_terms'
  if (primaryConstraint === 'post_click_issue') return 'review_landing_or_offer'

  return 'monitor'
}

/** Add primary_constraint and recommended_action columns to each row. */
export function addLeverDiagnosis<T extends LeverInputRow>(
  rows: T[],
  config: LeverConfig = DEFAULT_LEVER_CONFIG,
): Array<T & { primary_constraint: PrimaryConstraint; recommended_action: LeverRecommendedAction }> {
  return rows.map(r => {
    const primary_constraint = diagnosePrimaryConstraint(r)
    const withPc = { ...r, primary_constraint }
    const recommended_action = recommendAction(withPc, config)
    return { ...withPc, recommended_action }
  })
}
