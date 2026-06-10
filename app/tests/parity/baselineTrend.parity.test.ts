import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { assertParity } from './harness'

const FIX = resolve(__dirname, '../fixtures/parity')

describe('baselineTrend parity', () => {
  it('baseline_trend matches Python within 1e-6', () => {
    const input = coerceNumeric(
      readCsv(`${FIX}/input_apice_daily.csv`),
      [
        'cost',
        'conversion_value',
        'impressions',
        'clicks',
        'conversions',
        'impression_share',
        'lost_is_budget',
        'lost_is_rank',
      ],
    )
    const expected = coerceNumeric(
      readCsv(`${FIX}/expected_baseline_trend.csv`),
      [
        'cost',
        'conversion_value',
        'impressions',
        'clicks',
        'conversions',
        'impression_share',
        'lost_is_budget',
        'lost_is_rank',
        'ctr',
        'cpc',
        'cvr',
        'roas',
        'cost_7d',
        'cost_14d',
        'cost_28d',
        'conversion_value_7d',
        'conversion_value_14d',
        'conversion_value_28d',
        'roas_7d',
        'roas_14d',
        'roas_28d',
        'clicks_28d',
        'conversions_28d',
        'weekday',
        'same_weekday_roas',
        'ewma_roas',
      ],
    )
    const actual = buildBaselineTrendFeatures(input as any)
    assertParity(actual as any, expected as any, {
      keyCols: ['company', 'campaign_id', 'date'],
      tolerance: 1e-6,
    })
  })
})
