import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { assertParity } from './harness'
import { buildCampaignElasticityFeatures, type DailyInputRow } from '@/models/marginalElasticity'

const INPUT_NUMERIC = [
  'impressions',
  'clicks',
  'cost',
  'conversions',
  'conversion_value',
  'impression_share',
  'lost_is_budget',
  'lost_is_rank',
]

const OUTPUT_NUMERIC = [
  'current_cost',
  'current_conversion_value',
  'current_roas',
  'days_with_spend',
  'positive_revenue_days',
  'marginal_roas',
  'elasticity',
  'recommended_spend_band_min',
  'recommended_spend_band_max',
]

describe('marginal elasticity parity', () => {
  it('matches python expected_marginal_elasticity.csv within 1e-6', () => {
    const inputPath = resolve(__dirname, '../fixtures/parity/input_apice_daily.csv')
    const expectedPath = resolve(__dirname, '../fixtures/parity/expected_marginal_elasticity.csv')

    const rawInput = readCsv(inputPath)
    const input = coerceNumeric(rawInput, INPUT_NUMERIC) as unknown as DailyInputRow[]

    const rawExpected = readCsv(expectedPath)
    const expected = coerceNumeric(rawExpected, OUTPUT_NUMERIC)

    const actual = buildCampaignElasticityFeatures(input)

    assertParity(actual as unknown as Record<string, unknown>[], expected, {
      keyCols: ['company', 'campaign_id'],
      tolerance: 1e-6,
    })
  })
})
