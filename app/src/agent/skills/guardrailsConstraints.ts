// src/agent/skills/guardrailsConstraints.ts
//
// Optimization skill: wraps applyGuardrails. Used by the refiner (2.10c) and as
// a stand-alone skill to surface candidates that fail business constraints.

import { applyGuardrails, type GuardrailInputRow } from '@/models/constraintsOptimizer'
import type { Candidate, SkillDescriptor, SkillResult } from './types'
import type { RecommendedAction } from '@/core/types'

type GuardrailCandidateRow = GuardrailInputRow & {
  account_id?: string
  campaign_id?: string
  campaign_name?: string
}

interface GuardrailsInput {
  account_id: string
  candidates: GuardrailCandidateRow[]
}

function isInput(x: unknown): x is GuardrailsInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { candidates?: unknown }).candidates)
  )
}

function asAction(s: string | null | undefined): RecommendedAction {
  switch (s) {
    case 'increase_budget':
    case 'reduce_budget':
    case 'increase_troas_or_reduce_budget':
    case 'optimize_efficiency':
    case 'improve_ads_or_terms':
    case 'review_landing_or_offer':
    case 'monitor':
    case 'pause':
      return s
    default:
      return 'monitor'
  }
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'guardrails_constraints: invalid input shape' }
  }

  const evaluated = applyGuardrails(input.candidates)
  const candidates: Candidate[] = evaluated.map(r => ({
    account_id: input.account_id,
    campaign_id: String(r.campaign_id ?? ''),
    campaign_name: String(r.campaign_name ?? r.campaign_id ?? ''),
    skill_type: 'guardrails_constraints',
    recommended_action: asAction(
      typeof r.recommended_action === 'string' ? r.recommended_action : null,
    ),
    change_percent:
      typeof r.recommended_change_pct === 'number'
        ? r.recommended_change_pct
        : null,
    reason: r.constraints_reason,
    meta: {
      action_kind: r.action_kind,
      business_constraints_status: r.business_constraints_status,
      constraints_reason: r.constraints_reason,
      budget_action_rank: r.budget_action_rank,
      bid_action_rank: r.bid_action_rank,
    },
  }))

  return {
    candidates,
    notes: `guardrails_constraints: evaluated ${candidates.length}`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'guardrails_constraints',
  displayName: 'Guardrails & Constraints',
  category: 'optimization',
  description:
    'Apply business constraints and hard limits to candidate actions.',
  run,
}
