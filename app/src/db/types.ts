// src/db/types.ts
//
// Row-shape TS interfaces mirroring each table in `schema.ts`. Enums (status fields,
// guardrail status, risk level, outcome window) come from `@/core/types` so the
// HTTP/DTO layer, refiners, and DB layer all agree on the same vocabulary.

import type {
  GuardrailStatus,
  OutcomeWindow,
  RecommendationStatus,
  RiskLevel,
  SkillCategory,
} from '@/core/types'

// Re-export for downstream consumers that only import from `@/db/types`.
export type {
  GuardrailStatus,
  OutcomeWindow,
  RecommendationStatus,
  RiskLevel,
  SkillCategory,
}

/** Row in `accounts`. `default_approver_emails` is a JSON-encoded TEXT column. */
export interface AccountRow {
  account_id: string
  account_label: string
  company: string | null
  login_customer_id: string | null
  default_chat_space_id: string | null
  /** JSON-encoded `string[]` of email addresses, or null = any space member can approve. */
  default_approver_emails: string | null
  is_active: number
  created_at: string
  updated_at: string
}

/** Row in `model_runs`. */
export interface ModelRunRow {
  run_id: string
  account_id: string
  run_ts: string
  pipeline_version: string
  status: 'running' | 'success' | 'partial' | 'failed'
  n_campaigns_scanned: number | null
  n_recommendations: number | null
  input_window_start: string | null
  input_window_end: string | null
  notes: string | null
}

/** Row in `campaign_settings_snapshot`. */
export interface CampaignSettingsSnapshotRow {
  run_id: string
  account_id: string
  campaign_id: string
  campaign_name: string | null
  status: string | null
  bidding_strategy_type: string | null
  target_roas: number | null
  target_cpa_brl: number | null
  budget_amount_brl: number | null
  budget_resource_name: string | null
  captured_at: string
}

/** Row in `campaign_daily_features`. `anomaly_flags` is JSON-encoded TEXT. */
export interface CampaignDailyFeaturesRow {
  run_id: string
  account_id: string
  campaign_id: string
  date: string
  cost: number | null
  conversion_value: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
  ctr: number | null
  cpc: number | null
  cvr: number | null
  roas: number | null
  cost_7d: number | null
  cost_14d: number | null
  cost_28d: number | null
  conversion_value_7d: number | null
  conversion_value_14d: number | null
  conversion_value_28d: number | null
  roas_7d: number | null
  roas_14d: number | null
  roas_28d: number | null
  clicks_28d: number | null
  conversions_28d: number | null
  same_weekday_roas: number | null
  ewma_roas: number | null
  trend_status: string | null
  /** JSON-encoded `Record<string, boolean>` of anomaly flags, or null. */
  anomaly_flags: string | null
  confidence_score: number | null
}

/** Row in `campaign_hourly_metrics`. */
export interface CampaignHourlyMetricsRow {
  run_id: string
  account_id: string
  campaign_id: string
  hour_ts: string
  cost: number | null
  conversion_value: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
}

/** Row in `recommendations`. */
export interface RecommendationRow {
  recommendation_id: string
  run_id: string
  account_id: string
  campaign_id: string
  campaign_name: string
  skill_type: string
  recommended_action: string
  change_percent: number | null
  current_budget_brl: number | null
  proposed_budget_brl: number | null
  current_target_roas: number | null
  proposed_target_roas: number | null
  expected_incremental_cost_brl: number | null
  expected_incremental_revenue_brl: number | null
  expected_marginal_roas: number | null
  projected_cos: number | null
  confidence_score: number | null
  risk_level: RiskLevel | null
  reason: string | null
  guardrail_status: GuardrailStatus
  guardrail_reason: string | null
  /** JSON-encoded payload sent to the explanation LLM. */
  llm_payload: string | null
  llm_explanation: string | null
  /** Google Ads `campaignBudget.resource_name` (e.g. `customers/123/campaignBudgets/456`).
   *  Null when the campaign has no budget object (e.g. some Performance Max
   *  configs). Required by the executor for budget mutates. */
  budget_resource_name: string | null
  status: RecommendationStatus
  expires_at: string | null
  created_at: string
  updated_at: string
}

export type ChatDirection = 'outbound' | 'inbound'

/** Row in `chat_messages`. `payload` is JSON-encoded TEXT. */
export interface ChatMessageRow {
  message_id: string
  recommendation_id: string | null
  account_id: string
  space_id: string | null
  thread_id: string | null
  direction: ChatDirection
  /** JSON-encoded Google Chat request/response body. */
  payload: string
  created_at: string
}

export type ApprovalDecision = 'approved' | 'rejected'

/** Row in `approvals`. */
export interface ApprovalRow {
  approval_id: string
  recommendation_id: string
  account_id: string
  decision: ApprovalDecision
  decided_by: string | null
  decided_via: string | null
  decided_at: string
  note: string | null
}

export type ExecutionStatus = 'pending' | 'success' | 'failed'

/** Row in `executions`. `google_ads_request` and `google_ads_response` are JSON-encoded TEXT. */
export interface ExecutionRow {
  execution_id: string
  recommendation_id: string
  account_id: string
  attempt_number: number
  status: ExecutionStatus
  /** JSON-encoded request body sent to Google Ads. */
  google_ads_request: string | null
  /** JSON-encoded response body received from Google Ads. */
  google_ads_response: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

/** Row in `execution_outcomes`. */
export interface ExecutionOutcomeRow {
  outcome_id: string
  recommendation_id: string
  execution_id: string
  account_id: string
  window: OutcomeWindow
  observed_at: string
  observed_cost_brl: number | null
  observed_revenue_brl: number | null
  observed_roas: number | null
  observed_conversions: number | null
  expected_vs_actual_cost_delta: number | null
  expected_vs_actual_revenue_delta: number | null
  notes: string | null
}

/** Row in `skills`. */
export interface SkillRow {
  skill_key: string
  display_name: string
  category: SkillCategory
  description: string | null
  module_path: string | null
  created_at: string
  updated_at: string
}
