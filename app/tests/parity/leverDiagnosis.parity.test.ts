import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { addLeverDiagnosis } from '@/models/leverDiagnosis'
import { assertParity } from './harness'

const FIX = resolve(__dirname, '../fixtures/parity')

// Numeric columns referenced by lever_diagnosis or carried through from the
// enriched input. We coerce both actual and expected on these so the
// comparison treats them as floats (per harness tolerance).
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

describe('leverDiagnosis parity', () => {
  it('matches expected_lever_diagnosis.csv within 1e-6', () => {
    // The Python pipeline runs lever_diagnosis AFTER saturation, so its input
    // already carries saturation_level / saturation_reason /
    // pure_budget_increase_blocked. The fixture on disk
    // (input_latest_day_enriched.csv) is the pre-saturation enriched file, so
    // we splice the saturation columns from the expected CSV onto each row
    // before invoking addLeverDiagnosis. This mirrors what the chained
    // pipeline would feed the function.
    const inputRaw = coerceNumeric(
      readCsv(`${FIX}/input_latest_day_enriched.csv`),
      NUMERIC_COLS,
    )
    const expectedRaw = coerceNumeric(
      readCsv(`${FIX}/expected_lever_diagnosis.csv`),
      NUMERIC_COLS,
    )

    const satByKey = new Map<string, Record<string, unknown>>()
    for (const r of expectedRaw) {
      const k = `${String(r.company)}|${String(r.campaign_id)}`
      satByKey.set(k, {
        saturation_level: r.saturation_level,
        saturation_reason: r.saturation_reason,
        pure_budget_increase_blocked: r.pure_budget_increase_blocked,
      })
    }

    const enriched = inputRaw.map(r => {
      const k = `${String(r.company)}|${String(r.campaign_id)}`
      const sat = satByKey.get(k) ?? {}
      const pbib = sat.pure_budget_increase_blocked
      // pandas serialises booleans as 'True'/'False' in CSV. The Python
      // recommend_action() uses bool(row.get(...)) which would treat any
      // non-empty string as truthy, so we restore the Python-side bool here.
      const pbibBool =
        pbib === 'True' ? true : pbib === 'False' ? false : Boolean(pbib)
      return {
        ...r,
        saturation_level: sat.saturation_level,
        saturation_reason: sat.saturation_reason,
        pure_budget_increase_blocked: pbibBool,
      }
    })

    const actual = addLeverDiagnosis(enriched as any) as unknown as Record<
      string,
      unknown
    >[]

    // Normalise booleans to pandas CSV strings to match the expected fixture.
    const stringifyBool = (v: unknown) =>
      typeof v === 'boolean' ? (v ? 'True' : 'False') : v
    const normalised = actual.map(r => ({
      ...r,
      pure_budget_increase_blocked: stringifyBool(r.pure_budget_increase_blocked),
    }))

    // Project to only the columns the expected fixture cares about (input
    // fixture has extra columns like days_with_spend, target_roas, etc.).
    const expectedCols = new Set(Object.keys(expectedRaw[0] ?? {}))
    const projected = normalised.map(r => {
      const src = r as Record<string, unknown>
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(src)) if (expectedCols.has(k)) o[k] = src[k]
      return o
    })

    assertParity(projected, expectedRaw as any, {
      keyCols: ['company', 'campaign_id'],
      tolerance: 1e-6,
    })
  })
})
