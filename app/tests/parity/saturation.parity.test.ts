import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'csv-parse/sync'
import { join } from 'node:path'
import { coerceNumeric } from '@/lib/csv'
import { addSaturationFeatures } from '@/models/saturation'
import { assertParity } from './harness'

const FIXTURES = join(__dirname, '..', 'fixtures', 'parity')

// Numeric columns referenced by saturation logic (inputs) and any others that
// also appear on the expected side and must compare numerically.
const NUMERIC_COLS = [
  'impressions',
  'clicks',
  'cost',
  'conversions',
  'conversion_value',
  'impression_share',
  'lost_is_budget',
  'lost_is_rank',
  'ctr',
  'cpc',
  'cvr',
  'roas',
  'cost_7d',
  'conversion_value_7d',
  'roas_7d',
  'cost_14d',
  'conversion_value_14d',
  'roas_14d',
  'cost_28d',
  'conversion_value_28d',
  'roas_28d',
  'clicks_28d',
  'conversions_28d',
  'weekday',
  'same_weekday_roas',
  'ewma_roas',
  'confidence_score',
  'cost_28d_conf',
  'current_roas',
  'marginal_roas',
  'elasticity',
  'current_cost',
  'current_conversion_value',
  'campaign_type_avg_ctr',
  'campaign_type_avg_cvr',
  'campaign_type_avg_cpc',
  'campaign_type_avg_roas',
  'campaign_avg_roas',
  'proxy_target_roas',
  'recommended_change_pct',
]

function loadCsv(name: string): Record<string, unknown>[] {
  const path = join(FIXTURES, name)
  return parse(readFileSync(path, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, unknown>[]
}

describe('parity: saturation', () => {
  it('matches expected_saturation.csv within 1e-6', () => {
    const inputRaw = loadCsv('input_latest_day_enriched.csv')
    const input = coerceNumeric(inputRaw, NUMERIC_COLS)

    const expectedRaw = loadCsv('expected_saturation.csv')
    const expected = coerceNumeric(expectedRaw, NUMERIC_COLS)

    const actual = addSaturationFeatures(input as any) as unknown as Record<string, unknown>[]

    // Normalize boolean column to string ("True"/"False") to match pandas CSV serialization.
    const stringify = (v: unknown): string => {
      if (typeof v === 'boolean') return v ? 'True' : 'False'
      return String(v)
    }
    const normalized: Record<string, unknown>[] = actual.map(r => ({
      ...r,
      pure_budget_increase_blocked: stringify(r.pure_budget_increase_blocked),
    }))

    // Compare only on the columns the expected fixture cares about.
    const expectedCols = new Set(Object.keys(expected[0] ?? {}))
    const projected = normalized.map(r => {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(r)) if (expectedCols.has(k)) o[k] = r[k]
      return o
    })

    assertParity(projected, expected, {
      keyCols: ['company', 'campaign_id'],
      tolerance: 1e-6,
    })
  })
})
