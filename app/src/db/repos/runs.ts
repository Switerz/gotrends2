// src/db/repos/runs.ts
//
// Repository for the `model_runs` table. One row per pipeline invocation.

import type { GodeployDB } from '../bootstrap'
import { mapRow, mapRows } from '../rowMapper'
import type { ModelRunRow } from '../types'

export class RunsRepo {
  constructor(private readonly db: GodeployDB) {}

  async insert(row: Omit<ModelRunRow, 'run_ts'>): Promise<void> {
    await this.db.exec(
      `INSERT INTO model_runs (
        run_id, account_id, pipeline_version, status,
        n_campaigns_scanned, n_recommendations,
        input_window_start, input_window_end, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.run_id,
        row.account_id,
        row.pipeline_version,
        row.status,
        row.n_campaigns_scanned,
        row.n_recommendations,
        row.input_window_start,
        row.input_window_end,
        row.notes,
      ],
    )
  }

  async updateStatus(
    run_id: string,
    status: string,
    n_campaigns?: number | null,
    n_recommendations?: number | null,
  ): Promise<void> {
    await this.db.exec(
      `UPDATE model_runs
       SET status = ?, n_campaigns_scanned = ?, n_recommendations = ?
       WHERE run_id = ?`,
      [status, n_campaigns ?? null, n_recommendations ?? null, run_id],
    )
  }

  async getById(run_id: string): Promise<ModelRunRow | null> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM model_runs WHERE run_id = ? LIMIT 1`,
      [run_id],
    )
    if (rows.length === 0) return null
    return mapRow<ModelRunRow>(columns, rows[0]!)
  }

  async listByAccount(account_id: string, limit = 50): Promise<ModelRunRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM model_runs WHERE account_id = ? ORDER BY run_ts DESC LIMIT ?`,
      [account_id, limit],
    )
    return mapRows<ModelRunRow>(columns, rows)
  }
}
