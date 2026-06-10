// src/agent/skills/saturationCheck.ts
//
// Diagnostic skill: detect campaigns with demand-curve saturation.
// Composition: marginal-elasticity features feed into addSaturationFeatures.

import { buildCampaignElasticityFeatures, type DailyInputRow } from '@/models/marginalElasticity'
import { addSaturationFeatures, type SaturationInputRow } from '@/models/saturation'
import type { Candidate, SkillDescriptor, SkillResult } from './types'

interface SaturationCheckInput {
  account_id: string
  daily_rows: DailyInputRow[]
  /** Extra per-campaign signals (impression_share, lost_is_rank, etc.) keyed by campaign_id. */
  extra_signals?: Record<string, Partial<SaturationInputRow>>
}

function isInput(x: unknown): x is SaturationCheckInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { daily_rows?: unknown }).daily_rows)
  )
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'saturation_check: invalid input shape' }
  }

  const elasticity = buildCampaignElasticityFeatures(input.daily_rows)
  const extras = input.extra_signals ?? {}

  const satInput: SaturationInputRow[] = elasticity.map(f => ({
    marginal_roas: f.marginal_roas,
    elasticity: f.elasticity,
    campaign_avg_roas: f.current_roas,
    campaign_type_avg_roas: f.current_roas,
    ...(extras[f.campaign_id] ?? {}),
    campaign_id: f.campaign_id,
    campaign_name: f.campaign_name,
  }))

  const enriched = addSaturationFeatures(satInput)

  const candidates: Candidate[] = []
  for (const row of enriched) {
    const level = row.saturation_level
    if (level === 'low') continue
    const campaignId = String(row['campaign_id'] ?? '')
    candidates.push({
      account_id: input.account_id,
      campaign_id: campaignId,
      campaign_name: String(row['campaign_name'] ?? campaignId),
      skill_type: 'saturation_check',
      recommended_action:
        level === 'critical' || level === 'high' ? 'pause' : 'monitor',
      reason: row.saturation_reason,
      meta: {
        saturation_level: level,
        saturation_reason: row.saturation_reason,
        pure_budget_increase_blocked: row.pure_budget_increase_blocked,
      },
    })
  }

  return {
    candidates,
    notes: `saturation_check: ${candidates.length}/${enriched.length} saturated`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'saturation_check',
  displayName: 'Saturation Check',
  category: 'diagnostic',
  description:
    'Detect demand-curve saturation via diminishing-returns slope.',
  run,
}
