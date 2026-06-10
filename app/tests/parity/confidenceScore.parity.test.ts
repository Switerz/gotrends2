import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { assertParity } from './harness'
import { addConfidenceFeatures } from '@/models/confidenceScore'

const FIXTURES = resolve(__dirname, '../fixtures/parity')

const INPUT_NUMERIC_COLS = [
  'impressions',
  'clicks',
  'cost',
  'conversions',
  'conversion_value',
  'impression_share',
  'lost_is_budget',
  'lost_is_rank',
]

const EXPECTED_NUMERIC_COLS = [
  ...INPUT_NUMERIC_COLS,
  'cost_28d',
  'clicks_28d',
  'conversions_28d',
  'conversion_value_28d',
  'days_with_spend_28d',
  'roas',
  'roas_observations_28d',
  'avg_roas_28d',
  'stddev_roas_28d',
  'roas_28d',
  'roas_cv_28d',
  'cost_score',
  'clicks_score',
  'conversions_score',
  'spend_days_score',
  'volatility_penalty',
  'confidence_score',
]

describe('confidenceScore parity vs Python', () => {
  it('matches expected_confidence_score.csv within 1e-6', () => {
    const inputRaw = readCsv(resolve(FIXTURES, 'input_apice_daily.csv'))
    const input = coerceNumeric(inputRaw, INPUT_NUMERIC_COLS)

    const expectedRaw = readCsv(resolve(FIXTURES, 'expected_confidence_score.csv'))
    const expected = coerceNumeric(expectedRaw, EXPECTED_NUMERIC_COLS)

    const actual = addConfidenceFeatures(input as any)

    assertParity(actual as any, expected as any, {
      keyCols: ['company', 'campaign_id', 'date'],
      tolerance: 1e-6,
    })
  })
})
