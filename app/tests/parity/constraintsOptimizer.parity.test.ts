import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { applyGuardrails } from '@/models/constraintsOptimizer'
import { assertParity } from './harness'

const FIX = resolve(__dirname, '../fixtures/parity')

// Numeric columns that flow through constraints_optimizer. We coerce both
// sides so the harness compares them within tolerance instead of as strings.
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
  'marginal_roas_score',
  'opportunity_score',
  'budget_limitation_score',
  'stability_score',
  'roas_below_target_score',
  'negative_trend_score',
  'saturation_score',
  'wasted_spend_score',
  'maintenance_score',
  'scale_score',
  'efficiency_risk_score',
  'budget_action_rank',
  'bid_action_rank',
]

describe('constraintsOptimizer parity', () => {
  it('matches expected_constraints_optimizer.csv within 1e-6', () => {
    // The Python pipeline runs constraints_optimizer AFTER saturation +
    // lever_diagnosis + campaign_scores. The on-disk
    // input_latest_day_enriched.csv predates those stages, so we splice the
    // derived columns from expected_campaign_scores.csv (which is the direct
    // upstream of constraints_optimizer) onto each row. apply_guardrails only
    // ADDS columns (action_kind, business_constraints_status,
    // constraints_reason, budget_action_rank, bid_action_rank), so the
    // splice mirrors what the chained pipeline would feed it.
    const inputRaw = coerceNumeric(
      readCsv(`${FIX}/input_latest_day_enriched.csv`),
      NUMERIC_COLS,
    )
    const upstream = coerceNumeric(
      readCsv(`${FIX}/expected_campaign_scores.csv`),
      NUMERIC_COLS,
    )
    const expectedRaw = coerceNumeric(
      readCsv(`${FIX}/expected_constraints_optimizer.csv`),
      NUMERIC_COLS,
    )

    const byKey = new Map<string, Record<string, unknown>>()
    for (const r of upstream) {
      const k = `${String(r.company)}|${String(r.campaign_id)}`
      byKey.set(k, r)
    }

    const candidates = inputRaw.map(r => {
      const k = `${String(r.company)}|${String(r.campaign_id)}`
      const up = byKey.get(k) ?? {}
      // pandas serialises booleans as 'True'/'False' in CSV. The Python
      // apply_guardrails doesn't read pure_budget_increase_blocked, but it
      // passes through and must serialise identically. We restore the
      // Python-side bool here so emit-as-bool path produces 'True'/'False'.
      const pbib = (up as any).pure_budget_increase_blocked
      const pbibBool =
        pbib === 'True' ? true : pbib === 'False' ? false : Boolean(pbib)
      return {
        ...r,
        ...up,
        pure_budget_increase_blocked: pbibBool,
      }
    })

    const actual = applyGuardrails(candidates as any) as unknown as Record<
      string,
      unknown
    >[]

    // Project actual rows onto expected columns so the harness only checks
    // the columns the Python pipeline emits (input fixture has extras).
    const expectedCols = Object.keys(expectedRaw[0]!)
    const projected = actual.map(r => {
      const out: Record<string, unknown> = {}
      for (const c of expectedCols) {
        const v = (r as any)[c]
        // Booleans serialise to 'True'/'False' to match pandas CSV.
        if (typeof v === 'boolean') out[c] = v ? 'True' : 'False'
        else out[c] = v
      }
      return out
    })

    assertParity(projected, expectedRaw, {
      keyCols: ['company', 'campaign_id'],
      tolerance: 1e-6,
    })
  })
})
