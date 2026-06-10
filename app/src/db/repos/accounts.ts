// src/db/repos/accounts.ts
//
// Read-only repository for the `accounts` table. Account rows are inserted by
// `seedReferenceData` at worker startup, not by repo callers.

import type { GodeployDB } from '../bootstrap'
import { mapRow, mapRows } from '../rowMapper'
import type { AccountRow } from '../types'

export class AccountsRepo {
  constructor(private readonly db: GodeployDB) {}

  async get(account_id: string): Promise<AccountRow | null> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM accounts WHERE account_id = ? LIMIT 1`,
      [account_id],
    )
    if (rows.length === 0) return null
    return mapRow<AccountRow>(columns, rows[0]!)
  }

  async listActive(): Promise<AccountRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM accounts WHERE is_active = ? ORDER BY account_id`,
      [1],
    )
    return mapRows<AccountRow>(columns, rows)
  }
}
