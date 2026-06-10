// src/db/bootstrap.ts
//
// Idempotent schema + seed bootstrap. Called by the worker on cold start
// (see Task 5.1) so the SQLite database is always migrated and seeded
// before the first request is served.

import { SCHEMA_STATEMENTS, SEED_ACCOUNTS, SEED_SKILLS } from './schema'

/**
 * Minimal subset of the Godeploy `env.DB` interface the worker uses.
 *
 * In production this is satisfied by the Cloudflare Worker binding; in tests
 * we pass a fake object that records every call (see `tests/db/bootstrap.test.ts`).
 */
export interface GodeployDB {
  exec(sql: string, params?: unknown[]): Promise<{ rowsWritten: number }>
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ columns: string[]; rows: unknown[][]; rowsRead: number }>
}

/** Run every DDL statement in `SCHEMA_STATEMENTS` in order. Safe to call repeatedly. */
export async function bootstrapSchema(db: GodeployDB): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.exec(stmt)
  }
}

/**
 * Insert seed accounts (idempotent via `INSERT OR IGNORE`) and upsert the skill catalog
 * (`INSERT OR REPLACE`, so display_name/description/module_path stay in sync with code).
 */
export async function seedReferenceData(db: GodeployDB): Promise<void> {
  for (const a of SEED_ACCOUNTS) {
    await db.exec(
      `INSERT OR IGNORE INTO accounts (
        account_id, account_label, company, login_customer_id,
        default_chat_space_id, default_approver_emails
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        a.account_id,
        a.account_label,
        a.company,
        a.login_customer_id,
        a.default_chat_space_id,
        a.default_approver_emails,
      ],
    )
  }

  for (const s of SEED_SKILLS) {
    await db.exec(
      `INSERT OR REPLACE INTO skills (
        skill_key, display_name, category, description, module_path
      ) VALUES (?, ?, ?, ?, ?)`,
      [s.skill_key, s.display_name, s.category, s.description, s.module_path],
    )
  }
}
