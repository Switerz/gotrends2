// src/agent/skills/types.ts
//
// Shared types for the Skills layer (Ryze-style high-level capabilities).
// Skills compose one or more pure model ports (@/models/*) and produce
// raw Candidate[] outputs that the refiner (2.10c) validates + reshapes
// before persisting as DB Recommendations.

import type { GodeployDB } from '@/db/bootstrap'
import type {
  SkillCategory,
  RecommendedAction,
} from '@/core/types'

/**
 * Runtime context handed to every Skill.run().
 *
 * Phase 3 (clients) will extend this with metabase / googleAds / googleChat
 * client instances. Today only the db handle is required.
 */
export interface SkillContext {
  db: GodeployDB
}

/**
 * Raw candidate emitted by a Skill, prior to refinement/persistence.
 *
 * Mirrors the shape of `recommendations` in db/schema.ts but with looser
 * typing — the refiner (2.10c) is responsible for narrowing + filling
 * guardrail_status, llm_payload, etc.
 */
export interface Candidate {
  account_id: string
  campaign_id: string
  campaign_name: string
  skill_type: string
  recommended_action: RecommendedAction
  change_percent?: number | null
  current_budget_brl?: number | null
  proposed_budget_brl?: number | null
  current_target_roas?: number | null
  proposed_target_roas?: number | null
  expected_incremental_cost_brl?: number | null
  expected_incremental_revenue_brl?: number | null
  expected_marginal_roas?: number | null
  projected_cos?: number | null
  confidence_score?: number | null
  risk_level?: 'low' | 'medium' | 'high' | null
  reason?: string | null
  // Free-form context produced by the skill — refiner may strip or enrich.
  meta?: Record<string, unknown>
}

/** Shape returned by every Skill.run(). */
export interface SkillResult {
  candidates: Candidate[]
  /** Optional human-readable notes (debug, status, "no signal", etc.). */
  notes?: string
}

/**
 * Descriptor for a registered Skill. The `run()` function accepts an
 * arbitrary input (each skill documents what it accepts) plus the
 * SkillContext, and resolves to a SkillResult.
 */
export interface SkillDescriptor {
  key: string
  displayName: string
  category: SkillCategory
  description: string
  run(input: unknown, ctx: SkillContext): Promise<SkillResult>
}
