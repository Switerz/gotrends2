// tests/db/bootstrap.test.ts
//
// Verifies that:
//  - bootstrapSchema replays every DDL statement against the DB
//  - all 11 tables, the agent_decision_log view, and the expected indices are created
//  - seedReferenceData inserts the Apice account and the 10-skill catalog
//  - both functions are idempotent (calling them twice does not throw)

import { describe, it, expect } from 'vitest'
import {
  bootstrapSchema,
  seedReferenceData,
  type GodeployDB,
} from '@/db/bootstrap'
import { SEED_ACCOUNTS, SEED_SKILLS } from '@/db/schema'

interface RecordedExec {
  sql: string
  params: unknown[]
}

interface FakeDb extends GodeployDB {
  execs: RecordedExec[]
}

function fakeDb(): FakeDb {
  const execs: RecordedExec[] = []
  return {
    execs,
    async exec(sql: string, params: unknown[] = []) {
      execs.push({ sql, params })
      return { rowsWritten: 1 }
    },
    async query() {
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
}

const EXPECTED_TABLES = [
  'accounts',
  'model_runs',
  'campaign_settings_snapshot',
  'campaign_daily_features',
  'campaign_hourly_metrics',
  'recommendations',
  'chat_messages',
  'approvals',
  'executions',
  'execution_outcomes',
  'skills',
] as const

describe('bootstrapSchema', () => {
  it('runs all SCHEMA_STATEMENTS without throwing', async () => {
    const db = fakeDb()
    await bootstrapSchema(db)
    expect(db.execs.length).toBeGreaterThan(10)
  })

  it('creates all 11 tables', async () => {
    const db = fakeDb()
    await bootstrapSchema(db)
    for (const table of EXPECTED_TABLES) {
      const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`)
      const hit = db.execs.some((e) => pattern.test(e.sql))
      expect(hit, `expected CREATE TABLE for ${table}`).toBe(true)
    }
  })

  it('creates the agent_decision_log view (after dropping it)', async () => {
    const db = fakeDb()
    await bootstrapSchema(db)
    const dropIdx = db.execs.findIndex((e) =>
      /DROP VIEW IF EXISTS\s+agent_decision_log\b/.test(e.sql),
    )
    const createIdx = db.execs.findIndex((e) =>
      /CREATE VIEW\s+agent_decision_log\b/.test(e.sql),
    )
    expect(dropIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('creates at least 5 indices', async () => {
    const db = fakeDb()
    await bootstrapSchema(db)
    const indexCount = db.execs.filter((e) =>
      /CREATE INDEX IF NOT EXISTS/.test(e.sql),
    ).length
    expect(indexCount).toBeGreaterThanOrEqual(5)
  })
})

describe('seedReferenceData', () => {
  it('inserts exactly 1 account with INSERT OR IGNORE INTO accounts', async () => {
    const db = fakeDb()
    await seedReferenceData(db)
    const accountInserts = db.execs.filter((e) =>
      /INSERT OR IGNORE INTO accounts\b/.test(e.sql),
    )
    expect(accountInserts.length).toBe(1)
    // First parameter is the account_id; assert it matches the Apice seed.
    expect(accountInserts[0]!.params[0]).toBe('7705857660')
    expect(SEED_ACCOUNTS.length).toBe(1)
  })

  it('inserts 10 skills with INSERT OR REPLACE, covering all 3 categories', async () => {
    const db = fakeDb()
    await seedReferenceData(db)
    const skillInserts = db.execs.filter((e) =>
      /INSERT OR REPLACE INTO skills\b/.test(e.sql),
    )
    expect(skillInserts.length).toBe(10)
    expect(SEED_SKILLS.length).toBe(10)

    const categories = new Set(SEED_SKILLS.map((s) => s.category))
    expect(categories).toEqual(
      new Set(['diagnostic', 'optimization', 'reporting']),
    )
  })
})

describe('idempotency', () => {
  it('bootstrap + seed run twice without throwing', async () => {
    const db = fakeDb()
    await bootstrapSchema(db)
    await seedReferenceData(db)
    await bootstrapSchema(db)
    await seedReferenceData(db)
    // Sanity: total exec count is at least 2× a single pass.
    expect(db.execs.length).toBeGreaterThan(20)
  })
})
