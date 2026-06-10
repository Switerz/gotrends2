// src/core/types.ts

/** Workflow status of a recommendation in the decision lifecycle. */
export type RecommendationStatus =
  | 'pending'
  | 'sent_to_chat'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executing'
  | 'executed'
  | 'failed'

/** Output of the guardrails layer in the refiner. */
export type GuardrailStatus = 'ok' | 'needs_human_review' | 'blocked'

/** Risk classification surfaced to the human approver. */
export type RiskLevel = 'low' | 'medium' | 'high'

/** Skill category — Ryze-style taxonomy. */
export type SkillCategory = 'diagnostic' | 'optimization' | 'reporting'

/** Recommended action vocabulary. Must match what the refiner expects. */
export type RecommendedAction =
  | 'increase_budget'
  | 'reduce_budget'
  | 'increase_troas_or_reduce_budget'
  | 'optimize_efficiency'
  | 'improve_ads_or_terms'
  | 'review_landing_or_offer'
  | 'monitor'
  | 'pause'

/** Identifier of an outcome lookback window. */
export const OUTCOME_WINDOWS = ['24h', '72h', '7d'] as const
export type OutcomeWindow = (typeof OUTCOME_WINDOWS)[number]

/** Account in the platform (multi-tenant). */
export interface Account {
  account_id: string
  account_label: string
  company: string | null
  login_customer_id: string | null
  default_chat_space_id: string | null
  /** JSON array of emails, or null = any space member can approve. */
  default_approver_emails: string | null
}
