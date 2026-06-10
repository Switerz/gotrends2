// src/agent/skills/roasForecast.ts
//
// Reporting skill: project next-window ROAS from the baseline-trend EWMA.
// Wraps buildBaselineTrendFeatures and exposes the per-campaign ewma_roas as
// the headline forecast metric.

import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import type { Candidate, SkillDescriptor, SkillResult } from './types'

interface RoasForecastInput {
  account_id: string
  daily_rows: Array<Record<string, unknown>>
}

function isInput(x: unknown): x is RoasForecastInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { daily_rows?: unknown }).daily_rows)
  )
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'roas_forecast: invalid input shape' }
  }

  const enriched = buildBaselineTrendFeatures(input.daily_rows)
  if (enriched.length === 0) {
    return { candidates: [], notes: 'roas_forecast: empty input' }
  }

  // Keep only the last row per (company, campaign_id) — most recent forecast.
  const latest = new Map<string, Record<string, unknown>>()
  for (const r of enriched) {
    const key = `${String(r['company'] ?? '')}|${String(r['campaign_id'] ?? '')}`
    latest.set(key, r)
  }

  const candidates: Candidate[] = []
  for (const row of latest.values()) {
    const campaignId = String(row['campaign_id'] ?? '')
    const ewma = row['ewma_roas']
    candidates.push({
      account_id: input.account_id,
      campaign_id: campaignId,
      campaign_name: String(row['campaign_name'] ?? campaignId),
      skill_type: 'roas_forecast',
      recommended_action: 'monitor',
      reason: 'roas_forecast_snapshot',
      meta: {
        ewma_roas: ewma,
        roas_7d: row['roas_7d'],
        roas_14d: row['roas_14d'],
        roas_28d: row['roas_28d'],
        trend_status: row['trend_status'],
      },
    })
  }

  return {
    candidates,
    notes: `roas_forecast: ${candidates.length} campaigns forecasted`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'roas_forecast',
  displayName: 'ROAS Forecast',
  category: 'reporting',
  description: 'Project next-window ROAS from baseline trend.',
  run,
}
