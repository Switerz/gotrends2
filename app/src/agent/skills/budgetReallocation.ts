// src/agent/skills/budgetReallocation.ts
//
// Optimization skill: recommend budget shifts using marginal-ROAS elasticity,
// then layer in saturation flags + guardrails before emitting Candidate[].
//
// Composition:
//   buildCampaignElasticityFeatures
//   -> addSaturationFeatures
//   -> applyGuardrails
//   -> Candidate[]

import {
  buildCampaignElasticityFeatures,
  type DailyInputRow,
  type CampaignElasticityFeature,
} from '@/models/marginalElasticity'
import { addSaturationFeatures, type SaturationInputRow } from '@/models/saturation'
import {
  applyGuardrails,
  type GuardrailInputRow,
} from '@/models/constraintsOptimizer'
import type {
  Candidate,
  SkillDescriptor,
  SkillResult,
} from './types'
import type { RecommendedAction } from '@/core/types'

interface BudgetReallocationInput {
  account_id: string
  daily_rows: DailyInputRow[]
  /** Optional per-campaign current budget (BRL), keyed by campaign_id. */
  current_budgets?: Record<string, number>
  /** Optional per-campaign impression_share / lost_is signals. */
  extra_signals?: Record<string, Partial<SaturationInputRow>>
}

function isInput(x: unknown): x is BudgetReallocationInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { daily_rows?: unknown }).daily_rows)
  )
}

function decideAction(
  feature: CampaignElasticityFeature,
  saturated: boolean,
): { action: RecommendedAction; changePct: number } {
  const e = feature.elasticity
  if (saturated) return { action: 'reduce_budget', changePct: -10 }
  if (e !== null && e >= 0.8) return { action: 'increase_budget', changePct: 15 }
  if (e !== null && e <= 0.2) return { action: 'reduce_budget', changePct: -10 }
  return { action: 'monitor', changePct: 0 }
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'budget_reallocation: invalid input shape' }
  }

  const elasticityFeatures = buildCampaignElasticityFeatures(input.daily_rows)
  if (elasticityFeatures.length === 0) {
    return { candidates: [], notes: 'budget_reallocation: no elasticity features' }
  }

  const extras = input.extra_signals ?? {}
  const satInput: SaturationInputRow[] = elasticityFeatures.map(f => ({
    marginal_roas: f.marginal_roas,
    elasticity: f.elasticity,
    campaign_avg_roas: f.current_roas,
    campaign_type_avg_roas: f.current_roas,
    ...(extras[f.campaign_id] ?? {}),
    campaign_id: f.campaign_id,
    campaign_name: f.campaign_name,
  }))
  const saturated = addSaturationFeatures(satInput)
  const satByCampaign = new Map<string, (typeof saturated)[number]>()
  for (const s of saturated) {
    satByCampaign.set(String(s['campaign_id'] ?? ''), s)
  }

  // Build guardrail candidates so we can flag any blocked early.
  const budgets = input.current_budgets ?? {}
  const guardrailRows: (GuardrailInputRow & {
    campaign_id: string
    campaign_name: string
    elasticity_feature: CampaignElasticityFeature
    decided_action: RecommendedAction
    change_pct: number
  })[] = []

  for (const f of elasticityFeatures) {
    const sat = satByCampaign.get(f.campaign_id)
    const isSaturated =
      sat?.saturation_level === 'critical' || sat?.saturation_level === 'high'
    const { action, changePct } = decideAction(f, !!isSaturated)
    guardrailRows.push({
      campaign_id: f.campaign_id,
      campaign_name: f.campaign_name,
      recommended_action: action,
      recommended_change_pct: changePct,
      impression_share:
        typeof sat?.impression_share === 'number' ? sat.impression_share : null,
      date: f.date,
      elasticity_feature: f,
      decided_action: action,
      change_pct: changePct,
    })
  }

  const guardrailed = applyGuardrails(guardrailRows)

  const candidates: Candidate[] = guardrailed
    .filter(r => r.decided_action !== 'monitor')
    .map(r => {
      const f = r.elasticity_feature
      const currentBudget = budgets[r.campaign_id] ?? null
      const proposedBudget =
        currentBudget !== null ? currentBudget * (1 + r.change_pct / 100) : null
      return {
        account_id: input.account_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        skill_type: 'budget_reallocation',
        recommended_action: r.decided_action,
        change_percent: r.change_pct,
        current_budget_brl: currentBudget,
        proposed_budget_brl: proposedBudget,
        expected_marginal_roas: f.marginal_roas,
        reason:
          r.business_constraints_status === 'blocked'
            ? r.constraints_reason
            : 'elasticity_signal',
        meta: {
          elasticity: f.elasticity,
          marginal_roas: f.marginal_roas,
          model_level_used: f.model_level_used,
          guardrail_status: r.business_constraints_status,
          guardrail_reason: r.constraints_reason,
        },
      }
    })

  return {
    candidates,
    notes: `budget_reallocation: ${candidates.length}/${elasticityFeatures.length} campaigns actionable`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'budget_reallocation',
  displayName: 'Budget Reallocation',
  category: 'optimization',
  description: 'Recommend budget shifts using marginal-ROAS elasticity.',
  run,
}
