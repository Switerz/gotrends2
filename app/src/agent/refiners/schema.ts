// src/agent/refiners/schema.ts
//
// Zod schemas for the integrity gate between Skill outputs (Candidate, loose) and
// DB-ready Recommendation rows (strict). See docs/ARCHITECTURE.md → "agent/refiners/".

import { z } from 'zod'

/** Candidate = output of an agent/skills/*.run() — loose, what skills produce. */
export const CandidateSchema = z.object({
  account_id: z.string().min(1),
  campaign_id: z.string().min(1),
  campaign_name: z.string().min(1),
  skill_type: z.string().min(1),

  recommended_action: z.enum([
    'increase_budget',
    'reduce_budget',
    'increase_troas_or_reduce_budget',
    'optimize_efficiency',
    'improve_ads_or_terms',
    'review_landing_or_offer',
    'monitor',
    'pause',
  ]),

  change_percent: z.number().nullable(),
  current_budget_brl: z.number().nullable(),
  current_target_roas: z.number().nullable(),
  expected_marginal_roas: z.number().nullable(),

  confidence_score: z.number().int().min(0).max(100).nullable(),
  risk_level: z.enum(['low', 'medium', 'high']).nullable(),

  reason: z.string().nullable(),
  saturation_level: z.string().nullable().optional(),
  anomaly_flags: z.record(z.string(), z.boolean()).optional(),

  // Google Ads resource name for the campaign's budget object — fetched at
  // pipeline time so the executor can reference it directly instead of
  // synthesising an invalid placeholder. Optional on the Candidate (not every
  // skill knows the resource); persisted as `null` when omitted. The executor
  // fail-closes if a budget mutate reaches it without this field set.
  budget_resource_name: z.string().nullable().optional(),
})
export type Candidate = z.infer<typeof CandidateSchema>

/** Recommendation = DB row shape — strict, what RecommendationsRepo.insert accepts. */
export const RecommendationSchema = CandidateSchema.extend({
  recommendation_id: z.string().uuid(),
  run_id: z.string().uuid(),

  proposed_budget_brl: z.number().nullable(),
  proposed_target_roas: z.number().nullable(),
  expected_incremental_cost_brl: z.number().nullable(),
  expected_incremental_revenue_brl: z.number().nullable(),
  projected_cos: z.number().nullable(),

  guardrail_status: z.enum(['ok', 'needs_human_review', 'blocked']),
  guardrail_reason: z.string().nullable(),

  llm_payload: z.string().nullable(),
  llm_explanation: z.string().nullable(),

  status: z.enum([
    'pending',
    'sent_to_chat',
    'approved',
    'rejected',
    'expired',
    'executing',
    'executed',
    'failed',
  ]),
  expires_at: z.string().nullable(),
})
export type Recommendation = z.infer<typeof RecommendationSchema>
