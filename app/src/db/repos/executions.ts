// src/db/repos/executions.ts
//
// Repository for the `executions` table. One row per Google Ads mutate attempt.

import type { GodeployDB } from '../bootstrap'
import { mapRow, mapRows } from '../rowMapper'
import type { ExecutionRow } from '../types'

export class ExecutionsRepo {
  constructor(private readonly db: GodeployDB) {}

  async insert(row: Omit<ExecutionRow, 'created_at'>): Promise<void> {
    await this.db.exec(
      `INSERT INTO executions (
        execution_id, recommendation_id, account_id, attempt_number, status,
        google_ads_request, google_ads_response, error_message, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.execution_id,
        row.recommendation_id,
        row.account_id,
        row.attempt_number,
        row.status,
        row.google_ads_request,
        row.google_ads_response,
        row.error_message,
        row.completed_at,
      ],
    )
  }

  /**
   * Transition an execution row to a new status. `finishedAt` populates `completed_at`.
   * `errorCode` (when provided) is prefixed onto `error_message` since the schema
   * does not track a separate code column.
   */
  async setStatus(
    execution_id: string,
    status: string,
    finishedAt?: string | null,
    errorCode?: string | null,
    errorMessage?: string | null,
  ): Promise<void> {
    const combinedError =
      errorCode && errorMessage
        ? `[${errorCode}] ${errorMessage}`
        : errorCode
          ? `[${errorCode}]`
          : (errorMessage ?? null)

    await this.db.exec(
      `UPDATE executions
       SET status = ?, completed_at = ?, error_message = ?
       WHERE execution_id = ?`,
      [status, finishedAt ?? null, combinedError, execution_id],
    )
  }

  async getById(execution_id: string): Promise<ExecutionRow | null> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM executions WHERE execution_id = ? LIMIT 1`,
      [execution_id],
    )
    if (rows.length === 0) return null
    return mapRow<ExecutionRow>(columns, rows[0]!)
  }

  async listByRecommendation(recommendation_id: string): Promise<ExecutionRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM executions WHERE recommendation_id = ? ORDER BY attempt_number`,
      [recommendation_id],
    )
    return mapRows<ExecutionRow>(columns, rows)
  }

  async listByStatus(status: string, limit = 50): Promise<ExecutionRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM executions WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      [status, limit],
    )
    return mapRows<ExecutionRow>(columns, rows)
  }
}
