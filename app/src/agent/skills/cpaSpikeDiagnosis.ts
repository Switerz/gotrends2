// src/agent/skills/cpaSpikeDiagnosis.ts
//
// Diagnostic skill: identify which lever (CPC / CVR / AOV) is driving a CPA spike,
// wrapping the lever_diagnosis model.

import { addLeverDiagnosis, type LeverInputRow } from '@/models/leverDiagnosis'
import type { Candidate, SkillDescriptor, SkillResult } from './types'

type LeverInputWithMeta = LeverInputRow & {
  campaign_id?: string | null
  campaign_name?: string | null
}

interface LeverDiagnosisInput {
  account_id: string
  rows: LeverInputWithMeta[]
}

function isInput(x: unknown): x is LeverDiagnosisInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { rows?: unknown }).rows)
  )
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'cpa_spike_diagnosis: invalid input shape' }
  }

  const diagnosed = addLeverDiagnosis(input.rows)

  const candidates: Candidate[] = diagnosed
    .filter(r => r.primary_constraint !== 'monitor')
    .map(r => ({
      account_id: input.account_id,
      campaign_id: String(r.campaign_id ?? ''),
      campaign_name: String(r.campaign_name ?? r.campaign_id ?? ''),
      skill_type: 'cpa_spike_diagnosis',
      recommended_action: 'optimize_efficiency',
      reason: r.primary_constraint,
      meta: {
        primary_constraint: r.primary_constraint,
        recommended_action_lever: r.recommended_action,
      },
    }))

  return {
    candidates,
    notes: `cpa_spike_diagnosis: ${candidates.length}/${diagnosed.length} flagged`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'cpa_spike_diagnosis',
  displayName: 'CPA Spike Diagnosis',
  category: 'diagnostic',
  description:
    'Identify which lever (CPC, CVR, AOV) is dragging CPA off target.',
  run,
}
