/**
 * Saturation classification for GoTrends v2.
 *
 * Port of legacy/python/models/saturation.py with 1e-6 parity.
 *
 * Adds three derived columns to each campaign row:
 *  - saturation_level: 'critical' | 'high' | 'moderate' | 'low'
 *  - saturation_reason: string explaining why
 *  - pure_budget_increase_blocked: impression_share >= high_impression_share
 */

export interface SaturationConfig {
  highImpressionShare: number
  moderateImpressionShare: number
  highLostIsRank: number
  criticalMarginalRatio: number
  highElasticityFloor: number
  moderateElasticityFloor: number
}

export const DEFAULT_SATURATION_CONFIG: SaturationConfig = {
  highImpressionShare: 0.90,
  moderateImpressionShare: 0.80,
  highLostIsRank: 0.50,
  criticalMarginalRatio: 0.70,
  highElasticityFloor: 0.35,
  moderateElasticityFloor: 0.70,
}

export type SaturationLevel = 'critical' | 'high' | 'moderate' | 'low'

export interface SaturationInputRow {
  proxy_target_roas?: number | null
  marginal_roas?: number | null
  elasticity?: number | null
  impression_share?: number | null
  lost_is_rank?: number | null
  campaign_avg_roas?: number | null
  campaign_type_avg_roas?: number | null
  [key: string]: unknown
}

export interface SaturationOutputRow extends SaturationInputRow {
  proxy_target_roas: number | null
  saturation_level: SaturationLevel
  saturation_reason: string
  pure_budget_increase_blocked: boolean
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Equivalent to pandas isna() check (covers null/undefined/NaN). */
function isNa(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'number' && Number.isNaN(v)) return true
  return false
}

/** pandas.notna() */
function notNa(v: unknown): v is number {
  return isNum(v)
}

/** Returns [level, reason] for a single row. */
export function classifySaturation(
  row: SaturationInputRow,
  config: SaturationConfig = DEFAULT_SATURATION_CONFIG,
): [SaturationLevel, string] {
  const marginalRoas = row.marginal_roas
  const proxyTargetRoas = row.proxy_target_roas
  const elasticity = row.elasticity
  const impressionShare = row.impression_share
  const lostIsRank = row.lost_is_rank

  if (isNa(marginalRoas) || isNa(proxyTargetRoas)) {
    return ['critical', 'missing_marginal_or_proxy_target']
  }
  // After isNa guard, both are finite numbers.
  const m = marginalRoas as number
  const p = proxyTargetRoas as number

  if (m < p * config.criticalMarginalRatio) {
    return ['critical', 'marginal_roas_far_below_proxy_target']
  }
  if (notNa(elasticity) && elasticity < 0) {
    return ['critical', 'negative_elasticity']
  }
  if (notNa(impressionShare) && impressionShare >= config.highImpressionShare) {
    return ['high', 'impression_share_above_90pct']
  }
  if (m < p) {
    return ['high', 'marginal_roas_below_proxy_target']
  }
  if (notNa(elasticity) && elasticity < config.highElasticityFloor) {
    return ['high', 'low_elasticity']
  }
  if (notNa(impressionShare) && impressionShare >= config.moderateImpressionShare) {
    return ['moderate', 'impression_share_above_80pct']
  }
  if (notNa(lostIsRank) && lostIsRank >= config.highLostIsRank) {
    return ['moderate', 'high_lost_is_rank']
  }
  if (notNa(elasticity) && elasticity < config.moderateElasticityFloor) {
    return ['moderate', 'moderate_elasticity']
  }
  return ['low', 'room_to_scale']
}

/**
 * Adds saturation features to each row.
 *
 * Pandas semantics:
 *  - If `proxy_target_roas` is absent from the input, fallback to
 *    `campaign_avg_roas.combine_first(campaign_type_avg_roas)` (column-wise).
 *  - `pure_budget_increase_blocked = impression_share >= high_impression_share`
 *    Pandas Series.ge() treats NaN as False; we do the same.
 */
export function addSaturationFeatures<T extends SaturationInputRow>(
  rows: T[],
  config: SaturationConfig = DEFAULT_SATURATION_CONFIG,
): Array<T & {
  proxy_target_roas: number | null
  saturation_level: SaturationLevel
  saturation_reason: string
  pure_budget_increase_blocked: boolean
}> {
  if (rows.length === 0) return []

  const hasProxyCol = rows.some(r => 'proxy_target_roas' in r)

  return rows.map(r => {
    const next: Record<string, unknown> = { ...r }

    if (!hasProxyCol) {
      const avg = r.campaign_avg_roas
      const typeAvg = r.campaign_type_avg_roas
      next.proxy_target_roas = isNum(avg) ? avg : isNum(typeAvg) ? typeAvg : null
    } else if (next.proxy_target_roas === undefined) {
      next.proxy_target_roas = null
    }

    const [level, reason] = classifySaturation(next as SaturationInputRow, config)
    next.saturation_level = level
    next.saturation_reason = reason

    const is = (next as SaturationInputRow).impression_share
    next.pure_budget_increase_blocked = isNum(is) && is >= config.highImpressionShare

    return next as T & {
      proxy_target_roas: number | null
      saturation_level: SaturationLevel
      saturation_reason: string
      pure_budget_increase_blocked: boolean
    }
  })
}
