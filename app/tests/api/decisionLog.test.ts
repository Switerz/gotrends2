// tests/api/decisionLog.test.ts
//
// /api/decision-log proxies a SQL query against the agent_decision_log view.
// We don't need a real view here — we intercept the query and return canned
// columns + rows to assert the column->object mapping and the filter/limit
// branches.

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

function makeEnv(canned: { columns: string[]; rows: unknown[][] }, captured: CapturedQuery[]): Env {
  const db: GodeployDB = {
    async exec() {
      return { rowsWritten: 0 }
    },
    async query(sql, params = []) {
      if (/agent_decision_log/i.test(sql)) {
        captured.push({ sql, params })
        return { ...canned, rowsRead: canned.rows.length }
      }
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
  return { DB: db } as Env
}

describe('GET /api/decision-log', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('filters by account_id when provided', async () => {
    const captured: CapturedQuery[] = []
    const env = makeEnv({ columns: ['recommendation_id'], rows: [['r-1']] }, captured)
    const res = await worker.fetch(
      new Request('http://x/api/decision-log?account_id=acc-1&limit=50'),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.sql).toMatch(/WHERE account_id = \?/)
    expect(captured[0]!.params).toEqual(['acc-1', 50])
  })

  it('applies a default limit of 200 when none is provided', async () => {
    const captured: CapturedQuery[] = []
    const env = makeEnv({ columns: [], rows: [] }, captured)
    await worker.fetch(new Request('http://x/api/decision-log'), env, {} as ExecutionContext)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.sql).not.toMatch(/WHERE account_id/)
    expect(captured[0]!.params).toEqual([200])
  })

  it('maps columns + row tuples back into JSON objects', async () => {
    const captured: CapturedQuery[] = []
    const env = makeEnv(
      {
        columns: ['recommendation_id', 'account_id', 'skill_type', 'status'],
        rows: [
          ['r-1', 'acc-1', 'budget_reallocation', 'pending'],
          ['r-2', 'acc-1', 'anomaly_alert', 'approved'],
        ],
      },
      captured,
    )
    const res = await worker.fetch(new Request('http://x/api/decision-log'), env, {} as ExecutionContext)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toEqual([
      { recommendation_id: 'r-1', account_id: 'acc-1', skill_type: 'budget_reallocation', status: 'pending' },
      { recommendation_id: 'r-2', account_id: 'acc-1', skill_type: 'anomaly_alert', status: 'approved' },
    ])
  })
})
