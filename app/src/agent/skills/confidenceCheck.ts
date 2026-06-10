// src/agent/skills/confidenceCheck.ts
//
// Diagnostic skill: compute confidence scores for each campaign signal.
// Composition: buildBaselineTrendFeatures -> addConfidenceFeatures.

import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { addConfidenceFeatures } from '@/models/confidenceScore'
import type { Candidate, SkillDescriptor, SkillResult } from './types'

interface ConfidenceCheckInput {
  account_id: string
  daily_rows: Array<Record<string, unknown>>
  /** Score below this threshold becomes a candidate (default 60). */
  low_confidence_threshold?: number
}

function isInput(x: unknown): x is ConfidenceCheckInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { daily_rows?: unknown }).daily_rows)
  )
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'confidence_check: invalid input shape' }
  }

  const threshold = input.low_confidence_threshold ?? 60
  const enriched = buildBaselineTrendFeatures(input.daily_rows)
  const scored = addConfidenceFeatures(
    enriched as Parameters<typeof addConfidenceFeatures>[0],
  )

  const candidates: Candidate[] = []
  for (const row of scored) {
    const score = row['confidence_score']
    if (typeof score !== 'number' || score >= threshold) continue
    const campaignId = String(row['campaign_id'] ?? '')
    candidates.push({
      account_id: input.account_id,
      campaign_id: campaignId,
      campaign_name: String(row['campaign_name'] ?? campaignId),
      skill_type: 'confidence_check',
      recommended_action: 'monitor',
      confidence_score: score,
      reason: 'low_confidence',
      meta: { confidence_score: score },
    })
  }

  return {
    candidates,
    notes: `confidence_check: ${candidates.length} below ${threshold}`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'confidence_check',
  displayName: 'Confidence Check',
  category: 'diagnostic',
  description: 'Compute confidence score (0-100) for a campaign signal.',
  run,
}
