/**
 * Robust anomaly detection — TypeScript port of legacy/python/models/anomaly_detection.py.
 *
 * Per row, computes a robust z-score (0.6745 * (x - median) / MAD) for each metric
 * against the prior `lookbackDays` window of the same (company, campaign_id) series,
 * flags any |z| >= robustZThreshold, and produces aggregate counts.
 */

import { median as medianOf, isFiniteNumber } from '@/lib/stats'

export const KEY_COLUMNS = ['company', 'campaign_id'] as const
export const DEFAULT_METRICS = ['cpc', 'ctr', 'cvr', 'roas', 'cost', 'conversions'] as const

export type Metric = typeof DEFAULT_METRICS[number]

export interface AnomalyConfig {
  lookbackDays: number
  robustZThreshold: number
  minHistoryPoints: number
}

export const DEFAULT_CONFIG: AnomalyConfig = {
  lookbackDays: 28,
  robustZThreshold: 3.5,
  minHistoryPoints: 7,
}

const MS_PER_DAY = 86_400_000

/** Returns robust z = 0.6745 * (value - median(history)) / MAD(history). NaN if undefined. */
export function robustZScore(value: number | null | undefined, history: Array<number | null | undefined>): number {
  const clean = history.filter(isFiniteNumber) as number[]
  if (clean.length === 0 || !isFiniteNumber(value)) return NaN
  const med = medianOf(clean)
  const mad = medianOf(clean.map(v => Math.abs(v - med)))
  if (!isFiniteNumber(mad) || mad === 0) return NaN
  return (0.6745 * (value - med)) / mad
}

/** Parse a YYYY-MM-DD-ish string to a UTC epoch ms. Returns NaN if invalid. */
function parseDate(s: unknown): number {
  if (s instanceof Date) return s.getTime()
  if (typeof s !== 'string' || s === '') return NaN
  // Use first 10 chars to ignore any time component, parse as UTC date
  const d = new Date(s.length >= 10 ? s.slice(0, 10) : s)
  return d.getTime()
}

export type AnomalyRow<T extends Record<string, unknown>> = T & {
  [K in `${Metric}_robust_z`]: number | null
} & {
  [K in `${Metric}_anomaly`]: boolean
} & {
  anomaly_count: number
  critical_anomaly_block: boolean
}

/**
 * Add robust MAD-based anomaly z-scores and flags for each metric.
 *
 * Mirrors Python: per (company, campaign_id) group, rows are sorted by date,
 * and each row's history is the prior rows within [row.date - lookbackDays, row.date).
 * The current day is excluded from its own history.
 */
export function addRobustAnomalyFlags<T extends Record<string, unknown>>(
  df: T[],
  metrics: readonly string[] = DEFAULT_METRICS,
  config: Partial<AnomalyConfig> = {},
): Array<AnomalyRow<T>> {
  const cfg: AnomalyConfig = { ...DEFAULT_CONFIG, ...config }

  // Initialize all rows with default z=null (NaN sentinel) and flag=false
  const enriched = df.map(r => {
    const out: Record<string, unknown> = { ...r }
    for (const m of metrics) {
      out[`${m}_robust_z`] = null
      out[`${m}_anomaly`] = false
    }
    out['anomaly_count'] = 0
    out['critical_anomaly_block'] = false
    return out
  })

  // Group by (company, campaign_id) preserving insertion order
  const groups = new Map<string, number[]>()
  for (let i = 0; i < enriched.length; i++) {
    const r = enriched[i]!
    const key = `${String(r['company'] ?? '')}|${String(r['campaign_id'] ?? '')}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(i)
    else groups.set(key, [i])
  }

  for (const indices of groups.values()) {
    // Sort group indices by date ascending
    const sorted = indices
      .map(i => ({ i, t: parseDate(enriched[i]!['date']) }))
      .sort((a, b) => a.t - b.t)

    for (let pos = 0; pos < sorted.length; pos++) {
      const { i: rowIdx, t: rowTime } = sorted[pos]!
      if (!Number.isFinite(rowTime)) continue

      const startTime = rowTime - cfg.lookbackDays * MS_PER_DAY

      // Collect indices of history rows: same group, date in [startTime, rowTime)
      const historyIdx: number[] = []
      for (let j = 0; j < sorted.length; j++) {
        const { t } = sorted[j]!
        if (!Number.isFinite(t)) continue
        if (t >= startTime && t < rowTime) historyIdx.push(sorted[j]!.i)
      }

      const row = enriched[rowIdx]!

      for (const metric of metrics) {
        const histVals = historyIdx
          .map(idx => enriched[idx]![metric])
          .filter(isFiniteNumber) as number[]

        if (histVals.length < cfg.minHistoryPoints) continue

        const z = robustZScore(row[metric] as number | null | undefined, histVals)
        if (Number.isFinite(z)) {
          row[`${metric}_robust_z`] = z
          row[`${metric}_anomaly`] = Math.abs(z as number) >= cfg.robustZThreshold
        }
        // If z is NaN (mad==0 or value missing), leave defaults (null / false).
      }
    }
  }

  // Aggregate columns
  for (const row of enriched) {
    let count = 0
    for (const m of metrics) if (row[`${m}_anomaly`] === true) count++
    row['anomaly_count'] = count
    row['critical_anomaly_block'] =
      row['roas_anomaly'] === true ||
      row['cost_anomaly'] === true ||
      row['conversions_anomaly'] === true
  }

  return enriched as Array<AnomalyRow<T>>
}
