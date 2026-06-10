// src/agent/skills/registry.ts
//
// Central catalog of Skills (Ryze-style high-level capabilities). Each entry
// composes one or more model ports (@/models/*) and emits raw Candidate[].
// The refiner (task 2.10c) consumes these candidates and produces DB
// Recommendations.
//
// IMPORTANT: skill keys here MUST match the seeded keys in db/schema.ts
// (`SEED_SKILLS`). A registry test enforces this invariant.

export type { SkillContext, SkillDescriptor, SkillResult, Candidate } from './types'
import type { SkillDescriptor } from './types'

// Diagnostic
import { descriptor as anomalyAlert } from './anomalyAlert'
import { descriptor as cpaSpikeDiagnosis } from './cpaSpikeDiagnosis'
import { descriptor as confidenceCheck } from './confidenceCheck'
import { descriptor as saturationCheck } from './saturationCheck'

// Optimization
import { descriptor as budgetReallocation } from './budgetReallocation'
import { descriptor as guardrailsConstraints } from './guardrailsConstraints'
import { descriptor as projectedCosSkill } from './projectedCos'

// Reporting
import { descriptor as roasForecast } from './roasForecast'
import { descriptor as weeklyDigest } from './weeklyDigest'
import { descriptor as decisionBacktest } from './decisionBacktest'

export const SKILLS: readonly SkillDescriptor[] = [
  // diagnostic
  anomalyAlert,
  cpaSpikeDiagnosis,
  confidenceCheck,
  saturationCheck,
  // optimization
  budgetReallocation,
  guardrailsConstraints,
  projectedCosSkill,
  // reporting
  roasForecast,
  weeklyDigest,
  decisionBacktest,
]

/** Look up a skill descriptor by its `skill_key`. Returns undefined when unknown. */
export function findSkill(key: string): SkillDescriptor | undefined {
  return SKILLS.find(s => s.key === key)
}
