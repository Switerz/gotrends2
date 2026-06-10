// src/agent/skills/anomalyAlert.ts
//
// Diagnostic skill: surfaces campaigns whose recent metrics deviate enough from
// their own history to warrant attention (robust z-score outliers on ROAS/CPA/cost).
//
// Composition: buildBaselineTrendFeatures -> addRobustAnomalyFlags.
// Output: Candidate[] with skill_type='anomaly_alert' for rows whose anomaly_flags
// mark a critical block (the refiner decides whether to surface or suppress).

import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { addRobustAnomalyFlags } from '@/models/anomalyDetection'
import type { Candidate, SkillDescriptor, SkillResult } from './types'

interface AnomalyInput {
  account_id: string
  daily_rows: Array<Record<string, unknown>>
}

function isAnomalyInput(x: unknown): x is AnomalyInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { daily_rows?: unknown }).daily_rows)
  )
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isAnomalyInput(input)) {
    return { candidates: [], notes: 'anomaly_alert: invalid input shape' }
  }

  const enriched = buildBaselineTrendFeatures(input.daily_rows)
  const flagged = addRobustAnomalyFlags(enriched)

  const candidates: Candidate[] = []
  for (const row of flagged) {
    const flags = row['anomaly_flags']
    const critical =
      typeof flags === 'string' &&
      (flags.includes('critical') || flags.includes('block'))
    if (!critical) continue

    const campaignId = String(row['campaign_id'] ?? '')
    const campaignName = String(row['campaign_name'] ?? campaignId)
    candidates.push({
      account_id: input.account_id,
      campaign_id: campaignId,
      campaign_name: campaignName,
      skill_type: 'anomaly_alert',
      recommended_action: 'monitor',
      reason: typeof flags === 'string' ? flags : null,
      meta: { anomaly_flags: flags },
    })
  }

  return {
    candidates,
    notes: `anomaly_alert: scanned ${flagged.length} rows, flagged ${candidates.length}`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'anomaly_alert',
  displayName: 'Anomaly Alert',
  category: 'diagnostic',
  description:
    'Flag campaigns with robust z-score outliers on ROAS, CPA, or cost.',
  run,
}
