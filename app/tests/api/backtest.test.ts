// tests/api/backtest.test.ts
//
// HTTP-level tests for /api/backtest. Uses a fake DB that intercepts the
// recommendations × execution_outcomes join SQL and returns hand-crafted
// rows so we can drive the aggregation deterministically without spinning
// up SQLite.

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'
import { TEST_SESSION_SECRET, makeSessionCookie } from '../auth/_helpers'

interface Row {
  [k: string]: unknown
}

function makeEnv(seed: {
  joined?: Row[] // pre-joined recommendations × execution_outcomes rows
  accountFilter?: (accountId: string, rows: Row[]) => Row[]
}): Env {
  const joined = seed.joined ?? []

  const db: GodeployDB = {
    async exec() {
      return { rowsWritten: 0 }
    },
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim()

      // The backtest route's SELECT, regardless of WHERE clause. `norm` already
      // collapses whitespace, so a single space between identifiers is enough.
      if (/FROM\s+recommendations\s+r\s+LEFT\s+JOIN\s+execution_outcomes/i.test(norm)) {
        let working = joined
        let limit = 500
        if (/WHERE r\.account_id = \?/i.test(norm)) {
          const accountId = params[0] as string
          working =
            seed.accountFilter?.(accountId, joined) ??
            joined.filter((r) => r['account_id'] === accountId)
          limit = Number(params[1] ?? 500)
        } else {
          limit = Number(params[0] ?? 500)
        }
        return materialize(working.slice(0, limit))
      }

      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
  return { DB: db, SESSION_SECRET: TEST_SESSION_SECRET } as Env
}

function materialize(rows: Row[]) {
  // Always project to exactly the 6 columns the route reads, in that order,
  // so undefined values come through as null rather than being dropped.
  const columns = [
    'recommendation_id',
    'recommended_action',
    'business_constraints_status',
    'expected_incremental_revenue_brl',
    'observed_revenue_brl',
    'window',
  ]
  const tuples = rows.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c])))
  return { columns, rows: tuples, rowsRead: tuples.length }
}

function makeJoined(over: Partial<Row> = {}): Row {
  return {
    account_id: 'acc-1',
    recommendation_id: 'r-1',
    recommended_action: 'increase_budget',
    business_constraints_status: 'ok',
    expected_incremental_revenue_brl: 1000,
    observed_revenue_brl: 1100,
    window: '72h',
    ...over,
  }
}

const fetchJson = async (env: Env, url: string) => {
  const cookie = await makeSessionCookie()
  const res = await worker.fetch(
    new Request(`http://x${url}`, { headers: { cookie } }),
    env,
    {} as ExecutionContext,
  )
  return { status: res.status, body: (await res.json()) as unknown }
}

describe('GET /api/backtest', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 401 when no session cookie is present', async () => {
    const env = makeEnv({})
    const res = await worker.fetch(
      new Request('http://x/api/backtest'),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })

  it('returns zero summary and empty counts when DB has no rows', async () => {
    const env = makeEnv({})
    const { status, body } = await fetchJson(env, '/api/backtest')
    expect(status).toBe(200)
    const out = body as {
      summary: Record<string, number | null>
      counts: unknown[]
    }
    expect(out.summary.rows).toBe(0)
    expect(out.summary.evaluated_rows).toBe(0)
    expect(out.summary.candidate_rows).toBe(0)
    expect(out.summary.hit_rate).toBeNull()
    expect(out.summary.false_positive_rate).toBeNull()
    expect(out.summary.false_negative_rate).toBeNull()
    expect(out.summary.avg_expected_vs_realized_revenue_gap).toBeNull()
    expect(out.counts).toEqual([])
  })

  it('aggregates seeded recommendations × outcomes into a backtest summary', async () => {
    const env = makeEnv({
      joined: [
        // Within 10% of expectation → hit
        makeJoined({
          recommendation_id: 'r-hit-1',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: 1050,
        }),
        // Increase overdelivered → hit
        makeJoined({
          recommendation_id: 'r-hit-2',
          recommended_action: 'increase_budget',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: 2000,
        }),
        // Increase underdelivered → false_positive (worsened=true)
        makeJoined({
          recommendation_id: 'r-fp-1',
          recommended_action: 'increase_budget',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: 500,
        }),
        // Reduce overdelivered → false_positive (we cut too much)
        makeJoined({
          recommendation_id: 'r-fp-2',
          recommended_action: 'reduce_budget',
          expected_incremental_revenue_brl: -500,
          observed_revenue_brl: 200,
        }),
        // No outcome → no_followup_data (window=null, observed_revenue=null)
        makeJoined({
          recommendation_id: 'r-no-followup',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: null,
          window: null,
        }),
        // Blocked + worsened → excluded from actionable
        makeJoined({
          recommendation_id: 'r-blocked',
          business_constraints_status: 'blocked',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: 300,
        }),
      ],
    })
    const { status, body } = await fetchJson(env, '/api/backtest')
    expect(status).toBe(200)
    const out = body as {
      summary: {
        rows: number
        evaluated_rows: number
        candidate_rows: number
        hit_rate: number
        false_positive_rate: number
        worsened_recommended_rows: number
      }
      counts: Array<{ rows: number }>
    }
    expect(out.summary.rows).toBe(6)
    // 5 evaluated (everything except the null-outcome row)
    expect(out.summary.evaluated_rows).toBe(5)
    // 4 actionable (5 evaluated minus 1 blocked)
    expect(out.summary.candidate_rows).toBe(4)
    // 2 hits / 4 actionable = 0.5
    expect(out.summary.hit_rate).toBeCloseTo(0.5, 6)
    // 2 false_positives / 4 actionable = 0.5
    expect(out.summary.false_positive_rate).toBeCloseTo(0.5, 6)
    // Worsened among actionable: r-fp-1 (under-delivered)
    expect(out.summary.worsened_recommended_rows).toBe(1)
    // counts should be ordered DESC by row count
    for (let i = 1; i < out.counts.length; i++) {
      expect(out.counts[i]!.rows).toBeLessThanOrEqual(out.counts[i - 1]!.rows)
    }
  })

  it('honors ?account_id=… (only rows for that account flow through)', async () => {
    const env = makeEnv({
      joined: [
        makeJoined({
          account_id: 'acc-1',
          recommendation_id: 'r-a1',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: 1000,
        }),
        makeJoined({
          account_id: 'acc-2',
          recommendation_id: 'r-a2',
          expected_incremental_revenue_brl: 1000,
          observed_revenue_brl: 1000,
        }),
      ],
    })
    const { status, body } = await fetchJson(env, '/api/backtest?account_id=acc-1')
    expect(status).toBe(200)
    const out = body as { summary: { rows: number; candidate_rows: number } }
    expect(out.summary.rows).toBe(1)
    expect(out.summary.candidate_rows).toBe(1)
  })

  it('clamps ?limit into [1, 1000]', async () => {
    const calls: number[] = []
    const env = makeEnv({})
    const origQuery = env.DB.query.bind(env.DB)
    env.DB.query = async (sql, params = []) => {
      if (/FROM\s+recommendations\s+r\s+LEFT\s+JOIN\s+execution_outcomes/i.test(sql)) {
        const p = params as unknown[]
        calls.push(Number(p[p.length - 1]))
      }
      return origQuery(sql, params)
    }
    await fetchJson(env, '/api/backtest?limit=0')
    await fetchJson(env, '/api/backtest?limit=99999')
    await fetchJson(env, '/api/backtest?limit=200')
    expect(calls).toEqual([1, 1000, 200])
  })
})
