// tests/api/recommendations.test.ts
//
// HTTP-level tests for the recommendations router. We feed the worker a fake
// DB that satisfies just enough of the SQL surface used by RecommendationsRepo
// + AccountsRepo to round-trip rows through the route. Schema bootstrap is
// stubbed by ignoring DDL/seed exec calls (we don't need real tables here).

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'
import { TEST_SESSION_SECRET, makeSessionCookie } from '../auth/_helpers'

interface Row {
  [k: string]: unknown
}

function makeEnv(seed: {
  recommendations?: Row[]
  accounts?: Row[]
}): Env {
  const recs = seed.recommendations ?? []
  const accs = seed.accounts ?? []

  const db: GodeployDB = {
    async exec() {
      // Bootstrap DDL + seed go through here; we discard them.
      return { rowsWritten: 0 }
    },
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim()

      // recommendations getById
      let m = norm.match(/SELECT \* FROM recommendations WHERE recommendation_id = \? LIMIT 1/i)
      if (m) {
        const id = params[0]
        const row = recs.find((r) => r['recommendation_id'] === id)
        return materialize(row ? [row] : [])
      }

      // recommendations listByStatus
      m = norm.match(/SELECT \* FROM recommendations WHERE status = \? ORDER BY created_at DESC LIMIT \?/i)
      if (m) {
        const status = params[0]
        const lim = Number(params[1])
        const filtered = recs.filter((r) => r['status'] === status)
        return materialize(filtered.slice(0, lim))
      }

      // recommendations listRecent
      m = norm.match(/SELECT \* FROM recommendations ORDER BY created_at DESC LIMIT \?/i)
      if (m) {
        const lim = Number(params[0])
        return materialize(recs.slice(0, lim))
      }

      // accounts get
      m = norm.match(/SELECT \* FROM accounts WHERE account_id = \? LIMIT 1/i)
      if (m) {
        const id = params[0]
        const row = accs.find((a) => a['account_id'] === id)
        return materialize(row ? [row] : [])
      }

      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
  return { DB: db, SESSION_SECRET: TEST_SESSION_SECRET } as Env
}

function materialize(rows: Row[]) {
  const colSet = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) colSet.add(k)
  const columns = Array.from(colSet)
  const tuples = rows.map((r) => columns.map((c) => r[c] ?? null))
  return { columns, rows: tuples, rowsRead: tuples.length }
}

function makeRec(over: Partial<Row> = {}): Row {
  return {
    recommendation_id: 'r-1',
    run_id: 'run-1',
    account_id: 'acc-1',
    campaign_id: 'c-1',
    campaign_name: 'Search NB',
    skill_type: 'budget_reallocation',
    recommended_action: 'increase_budget',
    change_percent: 0.1,
    current_budget_brl: 1000,
    proposed_budget_brl: 1100,
    current_target_roas: null,
    proposed_target_roas: null,
    expected_incremental_cost_brl: 100,
    expected_incremental_revenue_brl: 300,
    expected_marginal_roas: 3,
    projected_cos: 0.33,
    confidence_score: 80,
    risk_level: 'medium',
    reason: 'test',
    guardrail_status: 'ok',
    guardrail_reason: null,
    llm_payload: null,
    llm_explanation: null,
    status: 'pending',
    expires_at: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
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

describe('GET /api/recommendations', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 401 when no session cookie is present', async () => {
    const env = makeEnv({})
    const res = await worker.fetch(
      new Request('http://x/api/recommendations'),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })

  it('returns [] when there are no recommendations', async () => {
    const env = makeEnv({})
    const { status, body } = await fetchJson(env, '/api/recommendations')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('filters by ?status=pending', async () => {
    const env = makeEnv({
      recommendations: [
        makeRec({ recommendation_id: 'r-pending', status: 'pending' }),
        makeRec({ recommendation_id: 'r-approved', status: 'approved' }),
      ],
      accounts: [{ account_id: 'acc-1', account_label: 'Apice' }],
    })
    const { status, body } = await fetchJson(env, '/api/recommendations?status=pending')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const list = body as Array<{ id: string; status: string; account: { label: string | null } }>
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('r-pending')
    expect(list[0]!.status).toBe('pending')
    expect(list[0]!.account.label).toBe('Apice')
  })

  it('returns the detail row by id', async () => {
    const env = makeEnv({
      recommendations: [makeRec({ recommendation_id: 'r-detail' })],
      accounts: [{ account_id: 'acc-1', account_label: 'Apice' }],
    })
    const { status, body } = await fetchJson(env, '/api/recommendations/r-detail')
    expect(status).toBe(200)
    const dto = body as { id: string; account: { label: string | null } }
    expect(dto.id).toBe('r-detail')
    expect(dto.account.label).toBe('Apice')
  })

  it('returns 404 when the id is unknown', async () => {
    const env = makeEnv({})
    const { status, body } = await fetchJson(env, '/api/recommendations/nope')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'not_found' })
  })

  it('clamps ?limit into [1, 500]', async () => {
    const calls: number[] = []
    const env = makeEnv({})
    const origQuery = env.DB.query.bind(env.DB)
    env.DB.query = async (sql, params = []) => {
      if (/FROM recommendations/i.test(sql) && /LIMIT \?/i.test(sql)) {
        calls.push(Number((params as unknown[])[params.length - 1]))
      }
      return origQuery(sql, params)
    }
    await fetchJson(env, '/api/recommendations?limit=0')
    await fetchJson(env, '/api/recommendations?limit=9999')
    await fetchJson(env, '/api/recommendations?limit=42')
    expect(calls).toEqual([1, 500, 42])
  })

  it('shapes the DTO with nested account/campaign/expected fields', async () => {
    const env = makeEnv({
      recommendations: [makeRec({ recommendation_id: 'r-shape' })],
      accounts: [{ account_id: 'acc-1', account_label: 'Apice' }],
    })
    const { body } = await fetchJson(env, '/api/recommendations/r-shape')
    const dto = body as Record<string, unknown>
    expect(Object.keys(dto).sort()).toEqual(
      [
        'account',
        'action',
        'campaign',
        'changePercent',
        'confidence',
        'createdAt',
        'current',
        'expected',
        'expiresAt',
        'guardrail',
        'id',
        'llmExplanation',
        'reason',
        'risk',
        'runId',
        'skill',
        'status',
        'proposed',
        'updatedAt',
      ].sort(),
    )
    expect((dto['account'] as Record<string, unknown>)['id']).toBe('acc-1')
    expect((dto['campaign'] as Record<string, unknown>)['name']).toBe('Search NB')
    expect((dto['expected'] as Record<string, unknown>)['marginalRoas']).toBe(3)
  })
})
