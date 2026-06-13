// src/db/repos/campaignRevenue.ts
//
// Repository for `campaign_revenue_daily`. Pipeline reads from here at runtime
// (cheap, deterministic SQL); the sync cron is the only writer.

import type { GodeployDB } from '../bootstrap'
import { mapRows } from '../rowMapper'
import type { CampaignRevenueDailyRow } from '../types'

export class CampaignRevenueRepo {
  constructor(private readonly db: GodeployDB) {}

  /**
   * Upsert one row. `INSERT OR REPLACE` is the simplest correct shape — the
   * sync cron always writes the canonical post-aggregate figure for a
   * (account, campaign, date) tuple, and re-syncs are expected to overwrite
   * yesterday's late-arriving orders cleanly.
   */
  async upsert(row: Omit<CampaignRevenueDailyRow, 'synced_at'>): Promise<void> {
    // synced_at omitted on purpose — the schema's DEFAULT (datetime('now'))
    // fills it. Keeping it out of the INSERT also dodges a nested-paren
    // limitation of the test fake DB.
    await this.db.exec(
      `INSERT OR REPLACE INTO campaign_revenue_daily (
        account_id, campaign_name, date, provider, revenue_brl, n_orders
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.account_id,
        row.campaign_name,
        row.date,
        row.provider,
        row.revenue_brl,
        row.n_orders,
      ],
    )
  }

  /** Upsert many rows in a tight loop. Workers don't expose multi-row
   *  binding cheaply, and the volumes here are small (≤ a few hundred
   *  campaigns × days per sync), so the simple loop wins on clarity. */
  async upsertMany(
    rows: ReadonlyArray<Omit<CampaignRevenueDailyRow, 'synced_at'>>,
  ): Promise<void> {
    for (const r of rows) {
      await this.upsert(r)
    }
  }

  /**
   * Return all rows for `account_id` in `[fromDate, toDate]` (inclusive).
   * The overlay map-builds from these.
   */
  async listByAccountAndDateRange(
    account_id: string,
    fromDate: string,
    toDate: string,
  ): Promise<CampaignRevenueDailyRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM campaign_revenue_daily
       WHERE account_id = ?
         AND date >= ?
         AND date <= ?`,
      [account_id, fromDate, toDate],
    )
    return mapRows<CampaignRevenueDailyRow>(columns, rows)
  }

  /**
   * Latest synced date for `account_id` (or null if the account has no
   * rows yet). Used by the sync cron to pick the resume point for
   * incremental fills.
   */
  async latestDateForAccount(account_id: string): Promise<string | null> {
    const { rows } = await this.db.query(
      `SELECT MAX(date) AS max_date FROM campaign_revenue_daily
       WHERE account_id = ?`,
      [account_id],
    )
    if (rows.length === 0) return null
    const row = rows[0]
    if (Array.isArray(row)) {
      const v = (row as unknown[])[0]
      return typeof v === 'string' ? v : null
    }
    const v = (row as Record<string, unknown>)['max_date']
    return typeof v === 'string' ? v : null
  }
}
