import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { addCampaignScores } from '@/models/campaignScores'
import { assertParity } from './harness'

const FIX = resolve(__dirname, '../fixtures/parity')

// Numeric columns used as inputs to addCampaignScores (read by the Python model).
const INPUT_NUMERIC_COLS = [
  'impressions', 'clicks', 'cost', 'conversions', 'conversion_value',
  'impression_share', 'lost_is_budget', 'lost_is_rank',
  'ctr', 'cpc', 'cvr', 'roas',
  'cost_7d', 'conversion_value_7d', 'roas_7d',
  'cost_14d', 'conversion_value_14d', 'roas_14d',
  'cost_28d', 'conversion_value_28d', 'roas_28d',
  'clicks_28d', 'conversions_28d', 'weekday',
  'same_weekday_roas', 'ewma_roas',
  'confidence_score', 'cost_28d_conf',
  'current_roas', 'marginal_roas', 'elasticity',
  'current_cost', 'current_conversion_value',
  'campaign_type_avg_ctr', 'campaign_type_avg_cvr',
  'campaign_type_avg_cpc', 'campaign_type_avg_roas',
  'campaign_avg_roas', 'proxy_target_roas', 'recommended_change_pct',
]

const EXPECTED_NUMERIC_COLS = [
  ...INPUT_NUMERIC_COLS,
  'marginal_roas_score', 'opportunity_score', 'budget_limitation_score',
  'stability_score', 'roas_below_target_score', 'negative_trend_score',
  'saturation_score', 'wasted_spend_score', 'maintenance_score',
  'scale_score', 'efficiency_risk_score',
]

describe('campaignScores parity', () => {
  it('matches Python add_campaign_scores within 1e-6', () => {
    // The Python pipeline feeds add_campaign_scores the output of
    // add_lever_diagnosis(add_saturation_features(input_latest_day_enriched)).
    // The base input fixture (input_latest_day_enriched.csv) lacks
    // saturation_level / saturation_reason / pure_budget_increase_blocked /
    // primary_constraint / recommended_action, which are produced upstream.
    // We hydrate those upstream columns from expected_lever_diagnosis.csv
    // (the validated output of the prior parity step).
    const baseRaw = readCsv<Record<string, string>>(resolve(FIX, 'input_latest_day_enriched.csv'))
    const upstreamRaw = readCsv<Record<string, string>>(resolve(FIX, 'expected_lever_diagnosis.csv'))
    const upstreamByKey = new Map(
      upstreamRaw.map(r => [`${r.company}|${r.campaign_id}`, r] as const),
    )
    const merged = baseRaw.map(r => {
      const up = upstreamByKey.get(`${r.company}|${r.campaign_id}`) ?? {}
      return {
        ...r,
        saturation_level: up.saturation_level ?? '',
        saturation_reason: up.saturation_reason ?? '',
        pure_budget_increase_blocked: up.pure_budget_increase_blocked ?? '',
        primary_constraint: up.primary_constraint ?? '',
        recommended_action: up.recommended_action ?? '',
      }
    })
    const input = coerceNumeric(merged, INPUT_NUMERIC_COLS)

    const expectedRaw = readCsv<Record<string, string>>(resolve(FIX, 'expected_campaign_scores.csv'))
    const expected = coerceNumeric(expectedRaw, EXPECTED_NUMERIC_COLS)

    const actualFull = addCampaignScores(input as any)

    // Project actual rows down to expected columns (drop input-only extras
    // like days_with_spend, positive_revenue_days, model_level_used,
    // target_roas, target_cpa_brl).
    const expectedCols = Object.keys(expected[0]!)
    const actual = actualFull.map(r => {
      const out: Record<string, unknown> = {}
      for (const c of expectedCols) out[c] = (r as any)[c]
      return out
    })

    assertParity(actual, expected, {
      keyCols: ['company', 'campaign_id'],
      tolerance: 1e-6,
    })
  })
})
