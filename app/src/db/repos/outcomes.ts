// src/db/repos/outcomes.ts
//
// Repository for the `execution_outcomes` table. Post-execution metric
// snapshot at 24h / 72h / 7d after a Google Ads mutate.

import type { GodeployDB } from '../bootstrap'
import { mapRows } from '../rowMapper'
import type { ExecutionOutcomeRow } from '../types'

export class OutcomesRepo {
  constructor(private readonly db: GodeployDB) {}

  async insert(row: Omit<ExecutionOutcomeRow, 'observed_at'>): Promise<void> {
    await this.db.exec(
      `INSERT INTO execution_outcomes (
        outcome_id, recommendation_id, execution_id, account_id, window,
        observed_cost_brl, observed_revenue_brl, observed_roas, observed_conversions,
        expected_vs_actual_cost_delta, expected_vs_actual_revenue_delta, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.outcome_id,
        row.recommendation_id,
        row.execution_id,
        row.account_id,
        row.window,
        row.observed_cost_brl,
        row.observed_revenue_brl,
        row.observed_roas,
        row.observed_conversions,
        row.expected_vs_actual_cost_delta,
        row.expected_vs_actual_revenue_delta,
        row.notes,
      ],
    )
  }

  async listByRecommendation(
    recommendation_id: string,
  ): Promise<ExecutionOutcomeRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM execution_outcomes WHERE recommendation_id = ?`,
      [recommendation_id],
    )
    return mapRows<ExecutionOutcomeRow>(columns, rows)
  }
}
