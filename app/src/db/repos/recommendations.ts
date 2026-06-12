// src/db/repos/recommendations.ts
//
// Repository for the `recommendations` table. The workflow-tracked artifact
// of a model run; one row equals one decision.

import type { GodeployDB } from '../bootstrap'
import { mapRow, mapRows } from '../rowMapper'
import type { RecommendationRow, RecommendationStatus } from '../types'

export class RecommendationsRepo {
  constructor(private readonly db: GodeployDB) {}

  async insert(
    row: Omit<RecommendationRow, 'created_at' | 'updated_at'>,
  ): Promise<void> {
    await this.db.exec(
      `INSERT INTO recommendations (
        recommendation_id, run_id, account_id, campaign_id, campaign_name,
        skill_type, recommended_action, change_percent,
        current_budget_brl, proposed_budget_brl,
        current_target_roas, proposed_target_roas,
        expected_incremental_cost_brl, expected_incremental_revenue_brl,
        expected_marginal_roas, projected_cos,
        confidence_score, risk_level, reason,
        guardrail_status, guardrail_reason,
        llm_payload, llm_explanation, budget_resource_name, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.recommendation_id,
        row.run_id,
        row.account_id,
        row.campaign_id,
        row.campaign_name,
        row.skill_type,
        row.recommended_action,
        row.change_percent,
        row.current_budget_brl,
        row.proposed_budget_brl,
        row.current_target_roas,
        row.proposed_target_roas,
        row.expected_incremental_cost_brl,
        row.expected_incremental_revenue_brl,
        row.expected_marginal_roas,
        row.projected_cos,
        row.confidence_score,
        row.risk_level,
        row.reason,
        row.guardrail_status,
        row.guardrail_reason,
        row.llm_payload,
        row.llm_explanation,
        row.budget_resource_name,
        row.status,
        row.expires_at,
      ],
    )
  }

  async setStatus(
    recommendation_id: string,
    status: RecommendationStatus,
  ): Promise<void> {
    await this.db.exec(
      `UPDATE recommendations
       SET status = ?, updated_at = datetime('now')
       WHERE recommendation_id = ?`,
      [status, recommendation_id],
    )
  }

  async getById(recommendation_id: string): Promise<RecommendationRow | null> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM recommendations WHERE recommendation_id = ? LIMIT 1`,
      [recommendation_id],
    )
    if (rows.length === 0) return null
    return mapRow<RecommendationRow>(columns, rows[0]!)
  }

  async listByStatus(
    status: RecommendationStatus,
    limit = 100,
  ): Promise<RecommendationRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM recommendations WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      [status, limit],
    )
    return mapRows<RecommendationRow>(columns, rows)
  }

  async listByAccountCampaign(
    account_id: string,
    campaign_id: string,
    limit = 50,
  ): Promise<RecommendationRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM recommendations
       WHERE account_id = ? AND campaign_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [account_id, campaign_id, limit],
    )
    return mapRows<RecommendationRow>(columns, rows)
  }

  async listRecent(limit = 100): Promise<RecommendationRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM recommendations ORDER BY created_at DESC LIMIT ?`,
      [limit],
    )
    return mapRows<RecommendationRow>(columns, rows)
  }
}
