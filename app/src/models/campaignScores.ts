/**
 * Port of legacy/python/models/campaign_scores.py — add scale, efficiency
 * risk, and maintenance scores per campaign row. Preserves input columns and
 * appends derived score columns (snake_case).
 */

type Row = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** pandas .replace(0, NaN) for safe denominators — returns null when value is 0. */
function nonZero(v: number | null): number | null {
  if (v === null) return null
  return v === 0 ? null : v
}

/** safeDiv: returns null when either operand is null or denominator is null/0. */
function safeDiv(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a / b
}

/** Clip a possibly-null score to [0, 100], treating null as 0. */
function clipScore(v: number | null): number {
  const x = v === null || Number.isNaN(v as number) ? 0 : v
  if (x < 0) return 0
  if (x > 100) return 100
  return x
}

const SATURATION_MAP: Record<string, number> = {
  critical: 100,
  high: 75,
  moderate: 40,
  low: 10,
}

/** Round half-away-from-zero (matches pandas .round() for typical positive scores). */
function roundHalfAwayFromZero(v: number): number {
  // For our domain (clipped 0..100 scores), this matches np.round/pandas .round().
  // Use the standard pattern: floor(x + 0.5) for non-negative values.
  if (v >= 0) return Math.floor(v + 0.5)
  return -Math.floor(-v + 0.5)
}

export function addCampaignScores<T extends Row>(rows: T[]): Array<T & {
  marginal_roas_score: number
  opportunity_score: number
  budget_limitation_score: number
  stability_score: number
  roas_below_target_score: number
  negative_trend_score: number
  saturation_score: number
  wasted_spend_score: number
  maintenance_score: number
  scale_score: number
  efficiency_risk_score: number
}> {
  return rows.map(r => {
    const marginal_roas = num(r['marginal_roas'])
    const proxy_target_roas = num(r['proxy_target_roas'])
    const lost_is_budget_raw = num(r['lost_is_budget'])
    const impression_share_raw = num(r['impression_share'])
    const lost_is_rank_raw = num(r['lost_is_rank'])
    const trend_status = (r['trend_status'] ?? '') === '' ? null : String(r['trend_status'])
    const current_roas = num(r['current_roas'])
    const current_cost = num(r['current_cost'])
    const cost_28d = num(r['cost_28d'])
    const ctr = num(r['ctr'])
    const cvr = num(r['cvr'])
    const cpc = num(r['cpc'])
    const campaign_type_avg_ctr = num(r['campaign_type_avg_ctr'])
    const campaign_type_avg_cvr = num(r['campaign_type_avg_cvr'])
    const campaign_type_avg_cpc = num(r['campaign_type_avg_cpc'])
    const confidence_score = num(r['confidence_score']) ?? 0
    const saturation_level = (r['saturation_level'] ?? '') === '' ? null : String(r['saturation_level'])

    // pandas fillna(0) semantics
    const lost_is_budget = lost_is_budget_raw ?? 0
    const lost_is_rank = lost_is_rank_raw ?? 0
    // pandas: out["impression_share"].fillna(0.50)
    const impression_share = impression_share_raw ?? 0.5

    // marginal_roas_score = 50 * marginal_roas / proxy_target_roas.replace(0, NaN)
    const marginal_roas_score = clipScore(
      (() => {
        const denom = nonZero(proxy_target_roas)
        if (marginal_roas === null || denom === null) return null
        return (50 * marginal_roas) / denom
      })(),
    )

    // opportunity_score = lost_is_budget.fillna(0)*100 + (1 - impression_share.fillna(0.5))*50
    const opportunity_score = clipScore(
      lost_is_budget * 100 + (1 - impression_share) * 50,
    )

    // budget_limitation_score = lost_is_budget.fillna(0) * 100
    const budget_limitation_score = clipScore(lost_is_budget * 100)

    // stability_score = np.select(...)
    let stability_score: number
    if (
      trend_status === 'strong_positive' ||
      trend_status === 'positive' ||
      trend_status === 'normal'
    ) {
      stability_score = 100
    } else if (trend_status === 'negative') {
      stability_score = 50
    } else if (trend_status === 'strong_negative') {
      stability_score = 0
    } else {
      stability_score = 40
    }

    // roas_below_target_score = (1 - current_roas / proxy_target_roas.replace(0, NaN)) * 100
    const roas_below_target_score = clipScore(
      (() => {
        const denom = nonZero(proxy_target_roas)
        if (current_roas === null || denom === null) return null
        return (1 - current_roas / denom) * 100
      })(),
    )

    // negative_trend_score = np.select(...)
    let negative_trend_score: number
    if (trend_status === 'strong_negative') negative_trend_score = 100
    else if (trend_status === 'negative') negative_trend_score = 70
    else if (trend_status === 'normal') negative_trend_score = 25
    else negative_trend_score = 0

    // saturation_score: map then fillna(40). Map result is NaN for unknown keys.
    const saturation_score =
      saturation_level !== null && saturation_level in SATURATION_MAP
        ? SATURATION_MAP[saturation_level]!
        : 40

    // wasted_spend_score = current_cost / cost_28d.replace(0, NaN) * 280
    const wasted_spend_score = clipScore(
      (() => {
        const denom = nonZero(cost_28d)
        if (current_cost === null || denom === null) return null
        return (current_cost / denom) * 280
      })(),
    )

    // maintenance_score = clip( lost_is_rank*70 + (ctr<typAvgCtr*0.70 ? 30 : 0)
    //                            + (cvr<typAvgCvr*0.70 ? 30 : 0)
    //                            + (cpc>typAvgCpc*1.30 ? 20 : 0) ).round().astype(int)
    // np.where with NaN: NaN < x is False → 0.
    const ctrBelow =
      ctr !== null && campaign_type_avg_ctr !== null && ctr < campaign_type_avg_ctr * 0.7
        ? 30
        : 0
    const cvrBelow =
      cvr !== null && campaign_type_avg_cvr !== null && cvr < campaign_type_avg_cvr * 0.7
        ? 30
        : 0
    const cpcAbove =
      cpc !== null && campaign_type_avg_cpc !== null && cpc > campaign_type_avg_cpc * 1.3
        ? 20
        : 0
    const maintenance_raw = lost_is_rank * 70 + ctrBelow + cvrBelow + cpcAbove
    const maintenance_score = roundHalfAwayFromZero(clipScore(maintenance_raw))

    // scale_score = round(clip(0.30*marginal_roas_score + 0.25*opportunity_score
    //                          + 0.20*budget_limitation_score + 0.15*confidence_score
    //                          + 0.10*stability_score)).astype(int)
    const scale_raw =
      0.3 * marginal_roas_score +
      0.25 * opportunity_score +
      0.2 * budget_limitation_score +
      0.15 * confidence_score +
      0.1 * stability_score
    const scale_score = (() => {
      const c = Math.min(100, Math.max(0, roundHalfAwayFromZero(scale_raw)))
      return c
    })()

    // efficiency_risk_score = round(clip(0.35*roas_below + 0.25*wasted + 0.20*negative_trend
    //                                    + 0.10*saturation + 0.10*confidence)).astype(int)
    const eff_raw =
      0.35 * roas_below_target_score +
      0.25 * wasted_spend_score +
      0.2 * negative_trend_score +
      0.1 * saturation_score +
      0.1 * confidence_score
    const efficiency_risk_score = Math.min(
      100,
      Math.max(0, roundHalfAwayFromZero(eff_raw)),
    )

    return {
      ...r,
      marginal_roas_score,
      opportunity_score,
      budget_limitation_score,
      stability_score,
      roas_below_target_score,
      negative_trend_score,
      saturation_score,
      wasted_spend_score,
      maintenance_score,
      scale_score,
      efficiency_risk_score,
    }
  })
}
