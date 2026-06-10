/**
 * TS port of legacy/python/models/confidence_score.py.
 *
 * Adds 28-day confidence features to daily campaign metrics. The current day
 * is excluded from its own lookback by shifting the series by 1 before each
 * rolling reduction (pandas: `s.shift(1).rolling(28, min_periods=...).<op>()`).
 *
 * Parity target: numeric columns within 1e-6 of the Python reference; string
 * outputs (`data_sufficiency`, `allow_budget_increase`, `allow_aggressive_action`)
 * are emitted verbatim ("insufficient" / "low" / "medium" / "high",
 * "True" / "False") so the CSV-based parity harness compares stringwise.
 */

import { groupBy, sortBy } from '@/lib/df'

export interface ConfidenceConfig {
  cost_threshold: number
  clicks_threshold: number
  conversions_threshold: number
  days_with_spend_threshold: number
  min_roas_observations: number
  low_threshold: number
  medium_threshold: number
  high_threshold: number
}

export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceConfig = {
  cost_threshold: 1000.0,
  clicks_threshold: 500.0,
  conversions_threshold: 20.0,
  days_with_spend_threshold: 14,
  min_roas_observations: 7,
  low_threshold: 40,
  medium_threshold: 60,
  high_threshold: 75,
}

type Num = number | null | undefined

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

/** Pandas: `s.shift(1).rolling(window, min_periods=1).sum()`.
 *  At index 0 the shifted window contains only NaN, so the result is null
 *  (matches pandas NaN for an all-NaN window). For i>0, sums non-null entries
 *  of values[max(0,i-window):i]; returns 0 if the window has only nulls. */
function rollingShiftedSumNullable(values: Num[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = 1; i < values.length; i++) {
    let s = 0
    let hasAny = false
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = values[j]
      if (isFiniteNum(v)) { s += v; hasAny = true }
    }
    // Window is [i-window, i). It always has at least one slot for i>=1.
    // With min_periods=1, the result is the sum of non-NaN values, or 0 if
    // the window had values (even if they were NaN, pandas treats NaN sum as 0
    // when at least one non-NaN exists; if ALL are NaN, result is NaN).
    // Practically, because shift(1) at i>=1 yields i values in the window, and
    // those are real input values (only NaN if the input itself had nulls),
    // we return null only when no non-null exists in the window AND there were
    // any slots; otherwise 0/sum.
    if (!hasAny) {
      // All-NaN window: pandas returns NaN with min_periods=1 only when count
      // of non-NaN is 0. Match that.
      out[i] = null
    } else {
      out[i] = s
    }
  }
  return out
}

/** Pandas: `(s.shift(1) > 0).rolling(window, min_periods=1).sum()`.
 *  The comparison `NaN > 0` is False, so missing prior days count as 0.
 *  Result for i=0 is sum over an empty window — with min_periods=1 pandas
 *  emits 0 because the bool series has no NaN (NaN>0 is False). */
function rollingShiftedDaysWithSpend(values: Num[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(0)
  // i=0: window is values[0:0] empty. But pandas rolling on a 1-length series
  // with min_periods=1 produces 0 (False rolled). Actually it produces 0.0:
  // shift(1) for the first row is NaN, NaN>0 is False (0), rolling sum is 0.
  for (let i = 0; i < values.length; i++) {
    let s = 0
    // For i=0 we consider the shifted single element (False = 0)
    if (i === 0) {
      out[i] = 0
      continue
    }
    const lo = Math.max(0, i - window)
    for (let j = lo; j < i; j++) {
      const v = values[j]
      if (isFiniteNum(v) && v > 0) s += 1
    }
    out[i] = s
  }
  return out
}

/** Pandas: `s.shift(1).rolling(window, min_periods=1).count()`.
 *  count() ignores NaN. At i=0 the shifted single value is NaN → count=0. */
function rollingShiftedCount(values: Num[], window: number): number[] {
  const out: number[] = new Array(values.length).fill(0)
  for (let i = 1; i < values.length; i++) {
    let c = 0
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (isFiniteNum(values[j])) c += 1
    }
    out[i] = c
  }
  return out
}

/** Pandas: `s.shift(1).rolling(window, min_periods=1).mean()`.
 *  Mean of non-NaN values in the prior window; null if no non-NaN. */
function rollingShiftedMean(values: Num[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = 1; i < values.length; i++) {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = values[j]
      if (isFiniteNum(v)) { s += v; c += 1 }
    }
    out[i] = c === 0 ? null : s / c
  }
  return out
}

/** Pandas: `s.shift(1).rolling(window, min_periods=min_periods).std()`.
 *  Sample stddev (ddof=1) of non-NaN values in the prior window; null if
 *  fewer than min_periods non-NaN values. */
function rollingShiftedStd(values: Num[], window: number, minPeriods: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = 1; i < values.length; i++) {
    const xs: number[] = []
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = values[j]
      if (isFiniteNum(v)) xs.push(v)
    }
    if (xs.length < minPeriods || xs.length < 2) { out[i] = null; continue }
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    let acc = 0
    for (const x of xs) acc += (x - m) ** 2
    out[i] = Math.sqrt(acc / (xs.length - 1))
  }
  return out
}

/** Pandas-like: `(25 * value.fillna(0) / threshold).clip(0, 25)`. */
function cappedComponent(value: number | null, threshold: number): number {
  const v = isFiniteNum(value) ? value : 0
  const raw = (25 * v) / threshold
  if (raw < 0) return 0
  if (raw > 25) return 25
  return raw
}

/** Banker's (round-half-to-even) rounding to integer, matching pandas
 *  Series.round / numpy.round semantics. */
function bankersRound(x: number): number {
  if (!Number.isFinite(x)) return x as number
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  // exactly 0.5: round to even
  return floor % 2 === 0 ? floor : floor + 1
}

interface InputRow extends Record<string, unknown> {
  company: string
  campaign_id: string
  date: string
  cost?: Num
  clicks?: Num
  conversions?: Num
  conversion_value?: Num
  roas?: Num
}

export type ConfidenceRow = InputRow & {
  cost_28d: number | null
  clicks_28d: number | null
  conversions_28d: number | null
  conversion_value_28d: number | null
  days_with_spend_28d: number
  roas: number | null
  roas_observations_28d: number
  avg_roas_28d: number | null
  stddev_roas_28d: number | null
  roas_28d: number | null
  roas_cv_28d: number | null
  cost_score: number
  clicks_score: number
  conversions_score: number
  spend_days_score: number
  volatility_penalty: number
  confidence_score: number
  data_sufficiency: string
  allow_budget_increase: string
  allow_aggressive_action: string
}

/** Compute `roas = conversion_value / cost` with cost==0 -> null (matches
 *  pandas `replace(0, np.nan)` followed by division). */
function safeRoas(numerator: Num, denom: Num): number | null {
  if (!isFiniteNum(numerator) || !isFiniteNum(denom) || denom === 0) return null
  return numerator / denom
}

export function addConfidenceFeatures<T extends InputRow>(
  df: T[],
  config: ConfidenceConfig = DEFAULT_CONFIDENCE_CONFIG,
): ConfidenceRow[] {
  if (df.length === 0) return []

  // Determine whether 'roas' was supplied on every row; pandas only computes
  // it when 'roas' is absent from the entire frame. We mirror that semantics:
  // if at least one input row already has a 'roas' key, treat the column as
  // present (consistent with how pandas checks `"roas" not in out.columns`).
  const roasProvided = df.some(r => 'roas' in r)

  // Group by (company, campaign_id), sort by date inside each group.
  const groups = groupBy(df, r => `${r.company}${r.campaign_id}`)

  // Result preserves the (company, campaign_id, date) sort order produced by
  // Python's `out.sort_values(KEY_COLUMNS + ["date"])`.
  const groupOrder = Array.from(groups.keys()).sort()

  const result: ConfidenceRow[] = []

  for (const gk of groupOrder) {
    const rowsRaw = groups.get(gk)!
    const rows = sortBy(rowsRaw, r => String(r.date))

    const cost = rows.map(r => (r.cost ?? null) as Num)
    const clicks = rows.map(r => (r.clicks ?? null) as Num)
    const conversions = rows.map(r => (r.conversions ?? null) as Num)
    const conversionValue = rows.map(r => (r.conversion_value ?? null) as Num)

    // roas: use provided column if present; otherwise compute safe division.
    const roas: Array<number | null> = rows.map(r => {
      if (roasProvided) {
        const v = (r as Record<string, unknown>).roas
        return isFiniteNum(v) ? v : null
      }
      return safeRoas(r.conversion_value ?? null, r.cost ?? null)
    })

    const cost28 = rollingShiftedSumNullable(cost, 28)
    const clicks28 = rollingShiftedSumNullable(clicks, 28)
    const conv28 = rollingShiftedSumNullable(conversions, 28)
    const convVal28 = rollingShiftedSumNullable(conversionValue, 28)
    const daysWithSpend28 = rollingShiftedDaysWithSpend(cost, 28)
    const roasObs28 = rollingShiftedCount(roas, 28)
    const avgRoas28 = rollingShiftedMean(roas, 28)
    const stdRoas28 = rollingShiftedStd(roas, 28, 2)

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      const c28 = cost28[i]!
      const cv28 = convVal28[i]!

      // roas_28d = conversion_value_28d / cost_28d, zero -> null
      const roas28: number | null =
        isFiniteNum(c28) && c28 !== 0 && isFiniteNum(cv28) ? cv28 / c28 : null

      // roas_cv_28d = std / |avg|, zero/null -> null
      const avg = avgRoas28[i]!
      const std = stdRoas28[i]!
      let roasCv: number | null = null
      if (isFiniteNum(std) && isFiniteNum(avg) && avg !== 0) {
        roasCv = std / Math.abs(avg)
      }

      const costScore = cappedComponent(c28, config.cost_threshold)
      const clicksScore = cappedComponent(clicks28[i]!, config.clicks_threshold)
      const conversionsScore = cappedComponent(conv28[i]!, config.conversions_threshold)
      const spendDaysScore = cappedComponent(
        daysWithSpend28[i]!,
        config.days_with_spend_threshold,
      )

      // volatility_penalty = ((cv - 0.5) / 1.5 * 25).clip(0,25).fillna(0)
      // .mask(roas_observations_28d < min_roas_obs, 20)
      let volatilityPenalty: number
      if (roasObs28[i]! < config.min_roas_observations) {
        volatilityPenalty = 20
      } else {
        if (roasCv === null || !Number.isFinite(roasCv)) {
          volatilityPenalty = 0
        } else {
          let v = ((roasCv - 0.5) / 1.5) * 25
          if (v < 0) v = 0
          if (v > 25) v = 25
          volatilityPenalty = v
        }
      }

      const rawScore =
        costScore + clicksScore + conversionsScore + spendDaysScore - volatilityPenalty
      let confScore = bankersRound(rawScore)
      if (confScore < 0) confScore = 0
      if (confScore > 100) confScore = 100

      // data_sufficiency via pd.cut bins=[-1, low-1, medium-1, high-1, 100]
      // labels=[insufficient, low, medium, high], right=True (default).
      // Interval semantics (left-open, right-closed):
      //   (-1, low-1]    -> insufficient
      //   (low-1, medium-1]  -> low
      //   (medium-1, high-1] -> medium
      //   (high-1, 100]      -> high
      const lowEdge = config.low_threshold - 1
      const medEdge = config.medium_threshold - 1
      const highEdge = config.high_threshold - 1
      let suff: string
      if (confScore <= lowEdge) suff = 'insufficient'
      else if (confScore <= medEdge) suff = 'low'
      else if (confScore <= highEdge) suff = 'medium'
      else suff = 'high'

      const allowBudget = confScore >= config.medium_threshold ? 'True' : 'False'
      const allowAggressive = confScore >= config.high_threshold ? 'True' : 'False'

      // Preserve input column order: spread r first, then append derived
      // columns in Python's append order. Python writes cost_28d, clicks_28d,
      // conversions_28d, conversion_value_28d, days_with_spend_28d, roas
      // (only if absent), roas_observations_28d, avg_roas_28d, stddev_roas_28d,
      // roas_28d, roas_cv_28d, cost_score, clicks_score, conversions_score,
      // spend_days_score, volatility_penalty, confidence_score,
      // data_sufficiency, allow_budget_increase, allow_aggressive_action.
      const out: Record<string, unknown> = { ...r }
      out.cost_28d = c28
      out.clicks_28d = clicks28[i]!
      out.conversions_28d = conv28[i]!
      out.conversion_value_28d = cv28
      out.days_with_spend_28d = daysWithSpend28[i]!
      out.roas = roas[i]
      out.roas_observations_28d = roasObs28[i]!
      out.avg_roas_28d = avg
      out.stddev_roas_28d = std
      out.roas_28d = roas28
      out.roas_cv_28d = roasCv
      out.cost_score = costScore
      out.clicks_score = clicksScore
      out.conversions_score = conversionsScore
      out.spend_days_score = spendDaysScore
      out.volatility_penalty = volatilityPenalty
      out.confidence_score = confScore
      out.data_sufficiency = suff
      out.allow_budget_increase = allowBudget
      out.allow_aggressive_action = allowAggressive

      result.push(out as ConfidenceRow)
    }
  }

  return result
}
