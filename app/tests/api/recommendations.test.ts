// tests/api/recommendations.test.ts
//
// HTTP-level tests for the recommendations router. We feed the worker a fake
// DB that satisfies just enough of the SQL surface used by RecommendationsRepo
// + AccountsRepo to round-trip rows through the route. Schema bootstrap is
// stubbed by ignoring DDL/seed exec calls (we don't need real tables here).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import { makeFakeDb } from '../db/repos/_fakeDb'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import type { RecommendationRow } from '@/db/types'
import type { GodeployDB } from '@/db/bootstrap'
import { TEST_SESSION_SECRET, makeSessionCookie } from '../auth/_helpers'

interface Row {
  [k: string]: unknown
}

function makeEnv(seed: {
  recommendations?: Row[]
  accounts?: Row[]
  executions?: Row[]
}): Env {
  const recs = seed.recommendations ?? []
  const accs = seed.accounts ?? []
  const execs = seed.executions ?? []

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

      // executions findLatestVerifiedByRecommendationIds (IN literal list)
      m = norm.match(
        /^SELECT \* FROM executions WHERE verified_at IS NOT NULL AND recommendation_id IN \(([^)]+)\) ORDER BY verified_at DESC$/i,
      )
      if (m) {
        const idList = m[1]!
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
        const ids = new Set(idList)
        const matched = execs
          .filter((e) => e['verified_at'] != null && ids.has(String(e['recommendation_id'])))
          .sort((a, b) =>
            String(a['verified_at']) < String(b['verified_at']) ? 1 : -1,
          )
        return materialize(matched)
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

  it('decorates listing rows with verification when a verified execution exists', async () => {
    const env = makeEnv({
      recommendations: [
        makeRec({ recommendation_id: '11111111-1111-4111-8111-111111111111', status: 'executed' }),
        makeRec({ recommendation_id: '22222222-2222-4222-8222-222222222222', status: 'pending' }),
      ],
      accounts: [{ account_id: 'acc-1', account_label: 'Apice' }],
      executions: [
        {
          execution_id: 'exec-1',
          recommendation_id: '11111111-1111-4111-8111-111111111111',
          verified_at: '2026-06-12T14:00:00Z',
          verification_status: 'match',
          verified_value: 5.5,
        },
      ],
    })
    const { body } = await fetchJson(env, '/api/recommendations')
    const list = body as Array<{ id: string; verification?: { status: string; observedValue: number; verifiedAt: string } | null }>
    const verifiedRec = list.find((r) => r.id === '11111111-1111-4111-8111-111111111111')
    expect(verifiedRec?.verification).toEqual({
      status: 'match',
      observedValue: 5.5,
      verifiedAt: '2026-06-12T14:00:00Z',
    })
    // The pending one has no verification — field absent.
    const pendingRec = list.find((r) => r.id === '22222222-2222-4222-8222-222222222222')
    expect(pendingRec?.verification).toBeUndefined()
  })

  it('listing rows have NO verification field when no executions have been verified', async () => {
    const env = makeEnv({
      recommendations: [makeRec({ recommendation_id: '33333333-3333-4333-8333-333333333333' })],
      accounts: [{ account_id: 'acc-1', account_label: 'Apice' }],
      // No executions seeded
    })
    const { body } = await fetchJson(env, '/api/recommendations')
    const list = body as Array<{ verification?: unknown }>
    expect(list[0]!.verification).toBeUndefined()
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

// ---------------------------------------------------------------------------
// POST /api/recommendations/:id/(approve|reject)
// ---------------------------------------------------------------------------
//
// These mirror the audit-trail contract of /chat/webhook but are driven by the
// SPA's session cookie rather than a Chat-issued JWT. We use the real
// _fakeDb so the row-write paths (approvals, chat_messages, status flip)
// actually exercise the repos.

function makeBootstrapTolerantEnv(over: Partial<Env> = {}): {
  env: Env
  db: ReturnType<typeof makeFakeDb>
} {
  const realDb = makeFakeDb()
  const realExec = realDb.exec.bind(realDb)
  const wrappedDb: GodeployDB = {
    async exec(sql: string, params?: unknown[]) {
      const head = sql.trim().toUpperCase()
      if (
        head.startsWith('CREATE TABLE') ||
        head.startsWith('CREATE INDEX') ||
        head.startsWith('CREATE UNIQUE') ||
        head.startsWith('CREATE VIEW') ||
        head.startsWith('CREATE TRIGGER') ||
        head.startsWith('DROP TABLE') ||
        head.startsWith('DROP VIEW') ||
        head.startsWith('DROP INDEX') ||
        head.startsWith('PRAGMA') ||
        head.startsWith('INSERT OR IGNORE') ||
        head.startsWith('INSERT OR REPLACE')
      ) {
        return { rowsWritten: 0 }
      }
      return realExec(sql, params)
    },
    query: realDb.query.bind(realDb),
  }
  const env: Env = {
    DB: wrappedDb,
    SESSION_SECRET: TEST_SESSION_SECRET,
    ...over,
  } as Env
  return { env, db: realDb }
}

async function seedRec(
  db: ReturnType<typeof makeFakeDb>,
  over: Partial<RecommendationRow> = {},
): Promise<string> {
  const recId = over.recommendation_id ?? 'rec-decision-1'
  const row: Omit<RecommendationRow, 'created_at' | 'updated_at'> = {
    recommendation_id: recId,
    run_id: 'run-1',
    account_id: 'acc-1',
    campaign_id: 'c-1',
    campaign_name: 'Search NB',
    skill_type: 'budget_reallocation',
    recommended_action: 'increase_budget',
    change_percent: 0.1,
    current_budget_brl: 100,
    proposed_budget_brl: 110,
    current_target_roas: null,
    proposed_target_roas: null,
    expected_incremental_cost_brl: 10,
    expected_incremental_revenue_brl: 30,
    expected_marginal_roas: 3,
    projected_cos: 0.2,
    confidence_score: 80,
    risk_level: 'medium',
    reason: 'roas trending up',
    guardrail_status: 'ok',
    guardrail_reason: null,
    llm_payload: null,
    llm_explanation: null,
    status: 'sent_to_chat',
    expires_at: null,
    ...over,
  } as Omit<RecommendationRow, 'created_at' | 'updated_at'>
  await new RecommendationsRepo(db).insert(row)
  return recId
}

async function postDecision(
  env: Env,
  id: string,
  action: 'approve' | 'reject',
  withCookie = true,
): Promise<{ res: Response; waitForBackground: () => Promise<void> }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (withCookie) headers.cookie = await makeSessionCookie()
  // Capture waitUntil promises so tests can await background work (the
  // approve handler now fires /api/execute via executionCtx.waitUntil).
  const bg: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      bg.push(p)
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  const res = await worker.fetch(
    new Request(`http://x/api/recommendations/${id}/${action}`, {
      method: 'POST',
      headers,
    }),
    env,
    ctx,
  )
  return {
    res,
    waitForBackground: async () => {
      await Promise.all(bg.map((p) => p.catch(() => undefined)))
    },
  }
}

describe('POST /api/recommendations/:id/(approve|reject)', () => {
  beforeEach(() => _resetBootstrapForTests())
  afterEach(() => vi.restoreAllMocks())

  it('returns 401 without a session cookie', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRec(db)
    const { res } = await postDecision(env, 'rec-decision-1', 'approve', false)
    expect(res.status).toBe(401)
  })

  it('approve happy path: writes approval + chat_message, flips status, auto-triggers execute', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ EXECUTE_TOKEN: 'exec-tok' })
    await seedRec(db, { recommendation_id: 'rec-approve' })

    const executeCalls: Array<{ url: string; init: RequestInit | undefined }> = []
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/execute/')) {
        executeCalls.push({ url, init })
        return new Response('{}', { status: 200 })
      }
      return realFetch(input, init)
    })

    const { res, waitForBackground } = await postDecision(env, 'rec-approve', 'approve')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; decision: string; recommendationId: string }
    expect(body).toEqual({ ok: true, decision: 'approved', recommendationId: 'rec-approve' })

    // The /api/execute call is fire-and-forget via executionCtx.waitUntil; await it
    // before asserting executeCalls to avoid a race with the assertion.
    await waitForBackground()

    const rec = db.tables.get('recommendations')?.find((r) => r['recommendation_id'] === 'rec-approve')
    expect(rec?.['status']).toBe('approved')

    const approvals = db.tables.get('approvals') ?? []
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!['decision']).toBe('approved')
    expect(approvals[0]!['decided_via']).toBe('web_ui')
    expect(approvals[0]!['decided_by']).toBe('pedro@gobeaute.com.br')
    expect(approvals[0]!['account_id']).toBe('acc-1')

    const chats = db.tables.get('chat_messages') ?? []
    expect(chats).toHaveLength(1)
    expect(chats[0]!['direction']).toBe('inbound')
    expect(chats[0]!['space_id']).toBeNull()
    const payload = JSON.parse(String(chats[0]!['payload']))
    expect(payload).toEqual({
      source: 'web_ui',
      action: 'approve',
      decided_by: 'pedro@gobeaute.com.br',
    })

    expect(executeCalls).toHaveLength(1)
    expect(executeCalls[0]!.url).toMatch(/\/api\/execute\/rec-approve$/)
    const headers = (executeCalls[0]!.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-execute-token']).toBe('exec-tok')
  })

  it('reject happy path: flips status to rejected, does not auto-trigger execute', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ EXECUTE_TOKEN: 'exec-tok' })
    await seedRec(db, { recommendation_id: 'rec-reject' })

    const executeCalls: string[] = []
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/execute/')) {
        executeCalls.push(url)
        return new Response('{}', { status: 200 })
      }
      return realFetch(input, init)
    })

    const { res } = await postDecision(env, 'rec-reject', 'reject')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { decision: string }
    expect(body.decision).toBe('rejected')

    const rec = db.tables.get('recommendations')?.find((r) => r['recommendation_id'] === 'rec-reject')
    expect(rec?.['status']).toBe('rejected')

    const approvals = db.tables.get('approvals') ?? []
    expect(approvals[0]!['decision']).toBe('rejected')
    expect(executeCalls).toEqual([])
  })

  it('returns 404 when the recommendation is unknown', async () => {
    const { env } = makeBootstrapTolerantEnv()
    const { res } = await postDecision(env, 'rec-missing', 'approve')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('returns 409 when the recommendation is no longer pending', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRec(db, { recommendation_id: 'rec-terminal', status: 'executed' })
    const { res } = await postDecision(env, 'rec-terminal', 'approve')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; currentStatus: string }
    expect(body.error).toBe('not_pending')
    expect(body.currentStatus).toBe('executed')
  })

  it('still succeeds (status=approved) even if the auto-execute call fails', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ EXECUTE_TOKEN: 'exec-tok' })
    await seedRec(db, { recommendation_id: 'rec-exec-fail' })

    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/api/execute/')) {
        throw new Error('network down')
      }
      return realFetch(input, init)
    })

    const { res, waitForBackground } = await postDecision(env, 'rec-exec-fail', 'approve')
    expect(res.status).toBe(200)
    // Approval is committed before the executor is even invoked; status flips to
    // 'approved' regardless of the background fetch outcome. Still drain the
    // background promise so the catch handler runs cleanly.
    await waitForBackground()
    const rec = db.tables.get('recommendations')?.find((r) => r['recommendation_id'] === 'rec-exec-fail')
    expect(rec?.['status']).toBe('approved')
  })
})
