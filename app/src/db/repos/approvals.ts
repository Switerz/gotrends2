// src/db/repos/approvals.ts
//
// Repository for the `approvals` table. One row per human decision on a
// recommendation (approved or rejected).

import type { GodeployDB } from '../bootstrap'
import { mapRows } from '../rowMapper'
import type { ApprovalRow } from '../types'

export class ApprovalsRepo {
  constructor(private readonly db: GodeployDB) {}

  async insert(row: Omit<ApprovalRow, 'decided_at'>): Promise<void> {
    await this.db.exec(
      `INSERT INTO approvals (
        approval_id, recommendation_id, account_id,
        decision, decided_by, decided_via, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.approval_id,
        row.recommendation_id,
        row.account_id,
        row.decision,
        row.decided_by,
        row.decided_via,
        row.note,
      ],
    )
  }

  async listByRecommendation(recommendation_id: string): Promise<ApprovalRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM approvals WHERE recommendation_id = ? ORDER BY decided_at DESC`,
      [recommendation_id],
    )
    return mapRows<ApprovalRow>(columns, rows)
  }
}
