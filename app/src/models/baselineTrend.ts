/**
 * Baseline & trend features (Sprint 3) — TS port of legacy/python/models/baseline_trend.py.
 *
 * Input grain: one row per (date, company, campaign_id) with raw daily metrics.
 * Output: original columns + derived ratios, rolling baselines, EWMA, weekday,
 * same_weekday_roas, ewma_roas, and trend_status.
 *
 * Parity contract: matches the Python reference within 1e-6 on all numeric columns.
 */

import { rollingSumPriorOnly, sortBy } from '@/lib/df'

export interface BaselineConfig {
  ewmaAlpha: number
  strongPositiveRatio: number
  positiveRatio: number
  negativeRatio: number
  strongNegativeRatio: number
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  ewmaAlpha: 0.4,
  strongPositiveRatio: 1.35,
  positiveRatio: 1.2,
  negativeRatio: 0.8,
  strongNegativeRatio: 0.65,
}

type Row = Record<string, unknown>

const KEY_COLS = ['company', 'campaign_id'] as const

/** safe_divide: n/d where d==0 or non-finite → null. Propagates null on n null. */
function safeDiv(n: unknown, d: unknown): number | null {
  if (n === null || n === undefined || d === null || d === undefined) return null
  if (typeof n !== 'number' || typeof d !== 'number') return null
  if (!Number.isFinite(n) || !Number.isFinite(d)) return null
  if (d === 0) return null
  return n / d
}

/** pandas dayofweek: Monday=0..Sunday=6. JS getUTCDay: Sunday=0..Saturday=6. */
function pandasWeekday(dateStr: unknown): number | null {
  if (typeof dateStr !== 'string' || dateStr === '') return null
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00Z'))
  if (Number.isNaN(d.getTime())) return null
  return (d.getUTCDay() + 6) % 7
}

function groupKey(r: Row): string {
  return `${String(r['company'] ?? '')}|${String(r['campaign_id'] ?? '')}`
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function classifyTrend(
  roas: number | null,
  roas28: number | null,
  cfg: BaselineConfig,
): string {
  if (roas === null || roas28 === null) return 'insufficient_data'
  if (roas > roas28 * cfg.strongPositiveRatio) return 'strong_positive'
  if (roas > roas28 * cfg.positiveRatio) return 'positive'
  if (roas < roas28 * cfg.strongNegativeRatio) return 'strong_negative'
  if (roas < roas28 * cfg.negativeRatio) return 'negative'
  return 'normal'
}

/**
 * Build baseline+trend features. Returns rows preserving the input column order
 * (per the first row's key insertion order), then appending derived columns:
 *   ctr, cpc, cvr, roas,
 *   cost_7d, conversion_value_7d, roas_7d,
 *   cost_14d, conversion_value_14d, roas_14d,
 *   cost_28d, conversion_value_28d, roas_28d,
 *   clicks_28d, conversions_28d,
 *   weekday, same_weekday_roas,
 *   ewma_roas,
 *   trend_status
 */
export function buildBaselineTrendFeatures(
  rows: Row[],
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
): Row[] {
  if (rows.length === 0) return []

  // Step 1 — copy + base ratios per row (no grouping yet).
  const inputCols = Object.keys(rows[0]!)
  const withRatios: Row[] = rows.map(r => {
    const out: Row = {}
    for (const c of inputCols) out[c] = r[c]
    out['ctr'] = safeDiv(r['clicks'], r['impressions'])
    out['cpc'] = safeDiv(r['cost'], r['clicks'])
    out['cvr'] = safeDiv(r['conversions'], r['clicks'])
    out['roas'] = safeDiv(r['conversion_value'], r['cost'])
    return out
  })

  // Step 2 — group by (company, campaign_id), stable sort by date asc.
  // Python sorts by KEY_COLS + ['date']; we sort each group independently then
  // emit rows by group order (the key order pandas would naturally use).
  const groups = new Map<string, Row[]>()
  for (const r of withRatios) {
    const k = groupKey(r)
    let bucket = groups.get(k)
    if (!bucket) {
      bucket = []
      groups.set(k, bucket)
    }
    bucket.push(r)
  }

  const enriched: Row[] = []
  for (const [, group] of groups) {
    const sorted = sortBy(group, r => String(r['date'] ?? ''))

    const cost = sorted.map(r => asNumberOrNull(r['cost']))
    const convVal = sorted.map(r => asNumberOrNull(r['conversion_value']))
    const clicks = sorted.map(r => asNumberOrNull(r['clicks']))
    const conversions = sorted.map(r => asNumberOrNull(r['conversions']))
    const roas = sorted.map(r => asNumberOrNull(r['roas']))

    // Rolling windows — prior rows only, min_periods=1 (so index 0 → 0 in pandas).
    // But: pandas with min_periods=1 returns 0.0 (sum starts at 0 even when all
    // prior values are NaN). For index 0 specifically, shift(1) yields NaN, and
    // rolling(window, min_periods=1).sum() on an all-NaN window is NaN.
    // Empirically the parity CSV shows '' (null) for first row's cost_7d. We
    // therefore use null for index 0 and 0.0 sum thereafter (matches rolling
    // semantics).
    const cost7 = rollingSumWithEmptyFirst(cost, 7)
    const cost14 = rollingSumWithEmptyFirst(cost, 14)
    const cost28 = rollingSumWithEmptyFirst(cost, 28)
    const cv7 = rollingSumWithEmptyFirst(convVal, 7)
    const cv14 = rollingSumWithEmptyFirst(convVal, 14)
    const cv28 = rollingSumWithEmptyFirst(convVal, 28)
    const clicks28 = rollingSumWithEmptyFirst(clicks, 28)
    const conv28 = rollingSumWithEmptyFirst(conversions, 28)

    // EWMA on prior-day roas: pandas does s.shift(1).ewm(alpha,adjust=False).mean()
    // with default ignore_na=False — when a NaN intervenes, the weights are
    // renormalized across the gap. We implement this locally rather than via
    // @/lib/stats.ewma (which freezes on NaN without renormalization).
    const shifted = [null as number | null, ...roas.slice(0, -1)]
    const ewmaRoas = ewmaPandas(shifted, config.ewmaAlpha)

    // Weekday + same_weekday_roas (subgroup by weekday within campaign, rolling 8 prior).
    const weekdays = sorted.map(r => pandasWeekday(r['date']))

    // Build per-weekday subsequences in order, then map back.
    const subIdxByWd = new Map<number, number[]>()
    for (let i = 0; i < sorted.length; i++) {
      const wd = weekdays[i]
      if (wd === null || wd === undefined) continue
      let arr = subIdxByWd.get(wd)
      if (!arr) {
        arr = []
        subIdxByWd.set(wd, arr)
      }
      arr.push(i)
    }
    const swCost = new Array<number | null>(sorted.length).fill(null)
    const swCv = new Array<number | null>(sorted.length).fill(null)
    for (const [, idxs] of subIdxByWd) {
      const wCost: Array<number | null> = idxs.map(i => cost[i] ?? null)
      const wCv: Array<number | null> = idxs.map(i => convVal[i] ?? null)
      const sCost = rollingSumWithEmptyFirst(wCost, 8)
      const sCv = rollingSumWithEmptyFirst(wCv, 8)
      for (let j = 0; j < idxs.length; j++) {
        swCost[idxs[j]!] = sCost[j] ?? null
        swCv[idxs[j]!] = sCv[j] ?? null
      }
    }
    const sameWdRoas = sorted.map((_, i) => safeDiv(swCv[i], swCost[i]))

    for (let i = 0; i < sorted.length; i++) {
      const r: Row = { ...sorted[i]! }
      r['cost_7d'] = cost7[i]
      r['conversion_value_7d'] = cv7[i]
      r['roas_7d'] = safeDiv(cv7[i], cost7[i])
      r['cost_14d'] = cost14[i]
      r['conversion_value_14d'] = cv14[i]
      r['roas_14d'] = safeDiv(cv14[i], cost14[i])
      r['cost_28d'] = cost28[i]
      r['conversion_value_28d'] = cv28[i]
      r['roas_28d'] = safeDiv(cv28[i], cost28[i])
      r['clicks_28d'] = clicks28[i]
      r['conversions_28d'] = conv28[i]
      r['weekday'] = weekdays[i]
      r['same_weekday_roas'] = sameWdRoas[i]
      r['ewma_roas'] = ewmaRoas[i]
      const roasI = asNumberOrNull(r['roas'])
      const roas28I = asNumberOrNull(r['roas_28d'])
      r['trend_status'] = classifyTrend(roasI, roas28I, config)
      enriched.push(r)
    }
  }

  return enriched
}

/** EWMA matching pandas .ewm(alpha=α, adjust=False, ignore_na=False).mean().
 *
 *  Semantics:
 *  - Indices before the first finite value yield null.
 *  - First finite x_k → y_k = x_k.
 *  - On finite x_t after k NaN steps since the last finite value:
 *      y_t = (α·x_t + (1-α)^(k+1)·y_last) / (α + (1-α)^(k+1))
 *  - On NaN x_t after at least one finite value: y_t = y_last (un-decayed),
 *    gap counter increments.
 */
function ewmaPandas(values: Array<number | null>, alpha: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  let yLast: number | null = null
  let gap = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    const finite = typeof v === 'number' && Number.isFinite(v)
    if (!finite) {
      if (yLast === null) {
        out[i] = null
      } else {
        out[i] = yLast
        gap += 1
      }
      continue
    }
    if (yLast === null) {
      yLast = v as number
      out[i] = yLast
      gap = 0
      continue
    }
    const wx = alpha
    const wy = Math.pow(1 - alpha, gap + 1)
    const yNew: number = (wx * (v as number) + wy * yLast) / (wx + wy)
    yLast = yNew
    out[i] = yNew
    gap = 0
  }
  return out
}

/** Rolling sum over prior rows only with pandas semantics:
 *  - index 0 → null (entire window is NaN after shift(1))
 *  - index i>0 → numeric sum of values[max(0,i-window):i], treating null as skip.
 *    Matches pandas rolling(window, min_periods=1).sum() on shifted series where
 *    at least one prior value exists.
 *
 *  Note: when all prior values are null, pandas yields NaN; here we use null to
 *  match the parity CSV (empty cell). For our input fixture every campaign has
 *  finite cost/clicks/conversions/conversion_value, so this edge only matters for
 *  edge-case tests.
 */
function rollingSumWithEmptyFirst(
  values: Array<number | null>,
  window: number,
): Array<number | null> {
  const sums = rollingSumPriorOnly(values, window)
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = 1; i < values.length; i++) {
    // Check if at least one prior value is finite within the window.
    let hasAny = false
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (typeof values[j] === 'number' && Number.isFinite(values[j] as number)) {
        hasAny = true
        break
      }
    }
    out[i] = hasAny ? sums[i]! : null
  }
  return out
}
