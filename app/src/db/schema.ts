// src/db/schema.ts
//
// SQLite DDL for the GoTrends v2 multi-tenant platform.
//
// Every statement is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
// `DROP VIEW IF EXISTS` + `CREATE VIEW`) so the worker can call `bootstrapSchema(db)` on
// every cold start without checking prior state.
//
// JSON-shaped columns are stored as `TEXT` (Godeploy SQLite has no native JSON type).

import type { SkillCategory } from '@/core/types'

/** Multi-statement DDL: each entry is one statement passed verbatim to `db.exec`. */
export const SCHEMA_STATEMENTS: string[] = [
  // ---------------------------------------------------------------------------
  // 1. accounts (one row per Google Ads MCC sub-account we operate on)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    account_label TEXT NOT NULL,
    company TEXT,
    login_customer_id TEXT,
    default_chat_space_id TEXT,
    default_approver_emails TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // ---------------------------------------------------------------------------
  // 2. model_runs (one row per pipeline invocation, per account)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS model_runs (
    run_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    run_ts TEXT NOT NULL DEFAULT (datetime('now')),
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
    n_campaigns_scanned INTEGER,
    n_recommendations INTEGER,
    input_window_start TEXT,
    input_window_end TEXT,
    notes TEXT
  )`,

  // ---------------------------------------------------------------------------
  // 3. campaign_settings_snapshot (Google Ads campaign-level config captured per run)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS campaign_settings_snapshot (
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    status TEXT,
    bidding_strategy_type TEXT,
    target_roas REAL,
    target_cpa_brl REAL,
    budget_amount_brl REAL,
    budget_resource_name TEXT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, campaign_id)
  )`,

  // ---------------------------------------------------------------------------
  // 4. campaign_daily_features (output of baseline_trend + anomaly + confidence, per day)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS campaign_daily_features (
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    campaign_id TEXT NOT NULL,
    date TEXT NOT NULL,
    cost REAL,
    conversion_value REAL,
    impressions INTEGER,
    clicks INTEGER,
    conversions REAL,
    ctr REAL,
    cpc REAL,
    cvr REAL,
    roas REAL,
    cost_7d REAL,
    cost_14d REAL,
    cost_28d REAL,
    conversion_value_7d REAL,
    conversion_value_14d REAL,
    conversion_value_28d REAL,
    roas_7d REAL,
    roas_14d REAL,
    roas_28d REAL,
    clicks_28d REAL,
    conversions_28d REAL,
    same_weekday_roas REAL,
    ewma_roas REAL,
    trend_status TEXT,
    anomaly_flags TEXT,
    confidence_score INTEGER,
    PRIMARY KEY (run_id, campaign_id, date)
  )`,

  // ---------------------------------------------------------------------------
  // 5. campaign_hourly_metrics (raw hourly metrics, used by anomaly detection)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS campaign_hourly_metrics (
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    campaign_id TEXT NOT NULL,
    hour_ts TEXT NOT NULL,
    cost REAL,
    conversion_value REAL,
    impressions INTEGER,
    clicks INTEGER,
    conversions REAL,
    PRIMARY KEY (run_id, campaign_id, hour_ts)
  )`,

  // ---------------------------------------------------------------------------
  // 6. recommendations (workflow-tracked artifact of a model run; one row = one decision)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS recommendations (
    recommendation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES model_runs(run_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    campaign_id TEXT NOT NULL,
    campaign_name TEXT NOT NULL,
    skill_type TEXT NOT NULL,
    recommended_action TEXT NOT NULL,
    change_percent REAL,
    current_budget_brl REAL,
    proposed_budget_brl REAL,
    current_target_roas REAL,
    proposed_target_roas REAL,
    expected_incremental_cost_brl REAL,
    expected_incremental_revenue_brl REAL,
    expected_marginal_roas REAL,
    projected_cos REAL,
    confidence_score INTEGER,
    risk_level TEXT,
    reason TEXT,
    guardrail_status TEXT NOT NULL,
    guardrail_reason TEXT,
    llm_payload TEXT,
    llm_explanation TEXT,
    -- Google Ads resource name for the campaign's budget object. Populated by
    -- the pipeline; required by the executor for budget mutates so we never
    -- synthesise a placeholder resource and submit a malformed mutate.
    budget_resource_name TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'sent_to_chat', 'approved', 'rejected',
      'expired', 'executing', 'executed', 'failed'
    )),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // ---------------------------------------------------------------------------
  // 7. chat_messages (audit log of every Google Chat round-trip)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS chat_messages (
    message_id TEXT PRIMARY KEY,
    recommendation_id TEXT REFERENCES recommendations(recommendation_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    space_id TEXT,
    thread_id TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // ---------------------------------------------------------------------------
  // 8. approvals (one row per human decision on a recommendation)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL REFERENCES recommendations(recommendation_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    decided_by TEXT,
    decided_via TEXT,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    note TEXT
  )`,

  // ---------------------------------------------------------------------------
  // 9. executions (one row per Google Ads mutate attempt)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL REFERENCES recommendations(recommendation_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    attempt_number INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
    google_ads_request TEXT,
    google_ads_response TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,

  // ---------------------------------------------------------------------------
  // 10. execution_outcomes (post-execution metric snapshot at 24h/72h/7d)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS execution_outcomes (
    outcome_id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL REFERENCES recommendations(recommendation_id),
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    window TEXT NOT NULL CHECK (window IN ('24h', '72h', '7d')),
    observed_at TEXT NOT NULL DEFAULT (datetime('now')),
    observed_cost_brl REAL,
    observed_revenue_brl REAL,
    observed_roas REAL,
    observed_conversions REAL,
    expected_vs_actual_cost_delta REAL,
    expected_vs_actual_revenue_delta REAL,
    notes TEXT
  )`,

  // ---------------------------------------------------------------------------
  // 11. skills (catalog of capabilities the agent can dispatch)
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS skills (
    skill_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('diagnostic', 'optimization', 'reporting')),
    description TEXT,
    module_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // ---------------------------------------------------------------------------
  // Indices: tuned for the queries the worker and UI run most often
  // ---------------------------------------------------------------------------
  `CREATE INDEX IF NOT EXISTS idx_model_runs_account_ts
     ON model_runs (account_id, run_ts DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_settings_run
     ON campaign_settings_snapshot (run_id)`,

  `CREATE INDEX IF NOT EXISTS idx_settings_account_campaign
     ON campaign_settings_snapshot (account_id, campaign_id)`,

  `CREATE INDEX IF NOT EXISTS idx_recommendations_status_created
     ON recommendations (status, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_recommendations_account_campaign_created
     ON recommendations (account_id, campaign_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_recommendations_run
     ON recommendations (run_id)`,

  `CREATE INDEX IF NOT EXISTS idx_chat_messages_recommendation
     ON chat_messages (recommendation_id)`,

  `CREATE INDEX IF NOT EXISTS idx_approvals_recommendation
     ON approvals (recommendation_id)`,

  `CREATE INDEX IF NOT EXISTS idx_executions_recommendation
     ON executions (recommendation_id)`,

  `CREATE INDEX IF NOT EXISTS idx_executions_status_created
     ON executions (status, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_outcomes_recommendation
     ON execution_outcomes (recommendation_id)`,

  // ---------------------------------------------------------------------------
  // View: agent_decision_log
  //
  // Denormalized 24h activity feed joining recommendations to account label,
  // most recent approval, most recent execution, and most recent outcome (any window).
  // Drop-then-create to keep the column list authoritative on every bootstrap.
  // ---------------------------------------------------------------------------
  `DROP VIEW IF EXISTS agent_decision_log`,

  `CREATE VIEW agent_decision_log AS
    SELECT
      r.recommendation_id,
      r.run_id,
      r.account_id,
      a.account_label,
      r.campaign_id,
      r.campaign_name,
      r.skill_type,
      r.recommended_action,
      r.change_percent,
      r.confidence_score,
      r.risk_level,
      r.guardrail_status,
      r.guardrail_reason,
      r.status,
      r.created_at,
      r.updated_at,
      ap.decision        AS approval_decision,
      ap.decided_by      AS approval_decided_by,
      ap.decided_at      AS approval_decided_at,
      ex.execution_id    AS execution_id,
      ex.status          AS execution_status,
      ex.completed_at    AS execution_completed_at,
      ex.error_message   AS execution_error,
      ou.window          AS outcome_window,
      ou.observed_roas   AS outcome_observed_roas,
      ou.observed_at     AS outcome_observed_at
    FROM recommendations r
    LEFT JOIN accounts a ON a.account_id = r.account_id
    LEFT JOIN (
      SELECT a1.*
      FROM approvals a1
      JOIN (
        SELECT recommendation_id, MAX(decided_at) AS max_decided_at
        FROM approvals GROUP BY recommendation_id
      ) latest
        ON latest.recommendation_id = a1.recommendation_id
       AND latest.max_decided_at = a1.decided_at
    ) ap ON ap.recommendation_id = r.recommendation_id
    LEFT JOIN (
      SELECT e1.*
      FROM executions e1
      JOIN (
        SELECT recommendation_id, MAX(created_at) AS max_created_at
        FROM executions GROUP BY recommendation_id
      ) latest
        ON latest.recommendation_id = e1.recommendation_id
       AND latest.max_created_at = e1.created_at
    ) ex ON ex.recommendation_id = r.recommendation_id
    LEFT JOIN (
      SELECT o1.*
      FROM execution_outcomes o1
      JOIN (
        SELECT recommendation_id, MAX(observed_at) AS max_observed_at
        FROM execution_outcomes GROUP BY recommendation_id
      ) latest
        ON latest.recommendation_id = o1.recommendation_id
       AND latest.max_observed_at = o1.observed_at
    ) ou ON ou.recommendation_id = r.recommendation_id
    WHERE r.created_at >= datetime('now', '-24 hours')`,
]

/**
 * Idempotent migrations applied AFTER `SCHEMA_STATEMENTS`. Each entry MUST be
 * safe to run repeatedly: bootstrap catches and silently ignores failures
 * matching `expectIfPresent` so SQLite's lack of `ADD COLUMN IF NOT EXISTS`
 * doesn't break cold start when the column was added on a previous deploy.
 *
 * When in doubt, prefer `CREATE TABLE IF NOT EXISTS` over a migration: the
 * migration path exists only for columns added to tables that pre-date the
 * change.
 */
export interface Migration {
  sql: string
  /** Substring of the error message to swallow (e.g. "duplicate column name"). */
  expectIfPresent: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    sql: `ALTER TABLE recommendations ADD COLUMN budget_resource_name TEXT`,
    expectIfPresent: 'duplicate column name',
  },
]

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export interface SeedAccount {
  account_id: string
  account_label: string
  company: string | null
  login_customer_id: string | null
  default_chat_space_id: string | null
  default_approver_emails: string | null
}

export interface SeedSkill {
  skill_key: string
  display_name: string
  category: SkillCategory
  description: string
  module_path: string | null
}

/** Bootstrap account — Apice / GoGroup is the first tenant we operate. */
export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  {
    account_id: '7705857660',
    account_label: 'Apice',
    company: 'Apice / GoGroup',
    login_customer_id: null,
    default_chat_space_id: null,
    default_approver_emails: null,
  },
]

/** Skill catalog — 10 capabilities mapped to the legacy Python models. */
export const SEED_SKILLS: readonly SeedSkill[] = [
  // diagnostic
  {
    skill_key: 'anomaly_alert',
    display_name: 'Anomaly Alert',
    category: 'diagnostic',
    description: 'Flag campaigns with robust z-score outliers on ROAS, CPA, or cost.',
    module_path: 'legacy/python/models/anomaly_detection.py',
  },
  {
    skill_key: 'cpa_spike_diagnosis',
    display_name: 'CPA Spike Diagnosis',
    category: 'diagnostic',
    description: 'Identify which lever (CPC, CVR, AOV) is dragging CPA off target.',
    module_path: 'legacy/python/models/lever_diagnosis.py',
  },
  {
    skill_key: 'confidence_check',
    display_name: 'Confidence Check',
    category: 'diagnostic',
    description: 'Compute confidence score (0–100) for a campaign signal.',
    module_path: 'legacy/python/models/confidence_score.py',
  },
  {
    skill_key: 'saturation_check',
    display_name: 'Saturation Check',
    category: 'diagnostic',
    description: 'Detect demand-curve saturation via diminishing-returns slope.',
    module_path: 'legacy/python/models/saturation.py',
  },

  // optimization
  {
    skill_key: 'budget_reallocation',
    display_name: 'Budget Reallocation',
    category: 'optimization',
    description: 'Recommend budget shifts using marginal-ROAS elasticity.',
    module_path: 'legacy/python/models/marginal_elasticity.py',
  },
  {
    skill_key: 'guardrails_constraints',
    display_name: 'Guardrails & Constraints',
    category: 'optimization',
    description: 'Apply business constraints and hard limits to candidate actions.',
    module_path: 'legacy/python/models/constraints_optimizer.py',
  },
  {
    skill_key: 'projected_cos',
    display_name: 'Projected COS',
    category: 'optimization',
    description: 'Project cost-of-sales after a proposed change.',
    module_path: 'legacy/python/models/projected_cos.py',
  },

  // reporting
  {
    skill_key: 'roas_forecast',
    display_name: 'ROAS Forecast',
    category: 'reporting',
    description: 'Project next-window ROAS from baseline trend.',
    module_path: 'legacy/python/models/baseline_trend.py',
  },
  {
    skill_key: 'weekly_digest',
    display_name: 'Weekly Digest',
    category: 'reporting',
    description: 'Aggregate weekly performance and recommendation outcomes.',
    module_path: null,
  },
  {
    skill_key: 'decision_backtest',
    display_name: 'Decision Backtest',
    category: 'reporting',
    description: 'Backtest past recommendations against realized metrics.',
    module_path: 'legacy/python/models/backtesting.py',
  },
]
