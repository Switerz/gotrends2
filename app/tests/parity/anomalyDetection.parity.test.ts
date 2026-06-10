import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { addRobustAnomalyFlags, DEFAULT_METRICS } from '@/models/anomalyDetection'
import { assertParity } from './harness'

const FIXTURES = resolve(__dirname, '../fixtures/parity')

const NUMERIC_INPUT_COLS = [
  'impressions', 'clicks', 'cost', 'conversions', 'conversion_value',
  'impression_share', 'lost_is_budget', 'lost_is_rank',
  'ctr', 'cpc', 'cvr', 'roas',
  'cost_7d', 'conversion_value_7d', 'roas_7d',
  'cost_14d', 'conversion_value_14d', 'roas_14d',
  'cost_28d', 'conversion_value_28d', 'roas_28d',
  'clicks_28d', 'conversions_28d',
  'weekday', 'same_weekday_roas', 'ewma_roas',
]

const Z_COLS = DEFAULT_METRICS.map(m => `${m}_robust_z`)
const FLAG_COLS = DEFAULT_METRICS.map(m => `${m}_anomaly`)
const NUMERIC_EXPECTED_COLS = [...NUMERIC_INPUT_COLS, ...Z_COLS, 'anomaly_count']

/** Convert booleans (or strings) to Python-style "True"/"False" for parity comparison. */
function stringifyBools<T extends Record<string, unknown>>(rows: T[], cols: string[]): T[] {
  return rows.map(r => {
    const out: Record<string, unknown> = { ...r }
    for (const c of cols) {
      const v = r[c]
      if (typeof v === 'boolean') out[c] = v ? 'True' : 'False'
      else if (v === 'true' || v === 'True') out[c] = 'True'
      else if (v === 'false' || v === 'False') out[c] = 'False'
      else out[c] = v
    }
    return out as T
  })
}

describe('parity: addRobustAnomalyFlags vs Python anomaly_detection', () => {
  it('matches expected_anomaly_detection.csv within 1e-6 tolerance', () => {
    const inputRaw = readCsv<Record<string, string>>(resolve(FIXTURES, 'expected_baseline_trend.csv'))
    const input = coerceNumeric(inputRaw, NUMERIC_INPUT_COLS)

    const expectedRaw = readCsv<Record<string, string>>(resolve(FIXTURES, 'expected_anomaly_detection.csv'))
    const expected = stringifyBools(
      coerceNumeric(expectedRaw, NUMERIC_EXPECTED_COLS),
      [...FLAG_COLS, 'critical_anomaly_block'],
    )

    const actualRaw = addRobustAnomalyFlags(input)
    const actual = stringifyBools(actualRaw, [...FLAG_COLS, 'critical_anomaly_block'])

    assertParity(actual, expected, {
      keyCols: ['company', 'campaign_id', 'date'],
      tolerance: 1e-6,
    })
  })
})
