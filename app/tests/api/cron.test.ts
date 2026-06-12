// tests/api/cron.test.ts
//
// HTTP tests for /cron/* routes. Verifies the `X-Godeploy-Cron` guard, the
// graceful "skipped" responses when env vars are unset, and the outcomes
// stubs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'
import { makeFakeDb } from '../db/repos/_fakeDb'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { ChatRepo } from '@/db/repos/chat'
import type { RecommendationRow } from '@/db/types'

interface Write {
  sql: string
  params: unknown[]
}

interface RecordingDB extends GodeployDB {
  writes: Write[]
}

function makeEnv(overrides: Partial<Env> = {}): { env: Env; db: RecordingDB } {
  const writes: Write[] = []
  const db: RecordingDB = {
    writes,
    async exec(sql, params = []) {
      writes.push({ sql, params })
      return { rowsWritten: 1 }
    },
    async query() {
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
  return {
    env: { DB: db, GODEPLOY_CRON_KEY: 'cron-secret', ...overrides } as Env,
    db,
  }
}

const post = (env: Env, headers: Record<string, string>, path: string) =>
  worker.fetch(
    new Request(`http://x${path}`, { method: 'POST', headers }),
    env,
    {} as ExecutionContext,
  )

describe('cron auth (requireCronKey)', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 403 without the X-Godeploy-Cron header', async () => {
    const { env } = makeEnv()
    const res = await post(env, {}, '/cron/run-models')
    expect(res.status).toBe(403)
  })

  it('returns 403 when the X-Godeploy-Cron header is wrong', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'nope' },
      '/cron/run-models',
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /cron/run-models', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 + skipped when Metabase / Google Ads env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/run-models',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      skipped: boolean
      reason: string
      missing: { metabase: boolean; googleAds: boolean }
    }
    expect(body.skipped).toBe(true)
    expect(body.reason).toBe('env_missing')
    expect(body.missing.metabase).toBe(true)
    expect(body.missing.googleAds).toBe(true)
  })
})

describe('POST /cron/send-to-chat', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 + skipped when GOOGLE_CHAT_WEBHOOK_URL is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/send-to-chat',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: boolean; reason: string }
    expect(body.skipped).toBe(true)
    expect(body.reason).toBe('no_webhook')
  })

  describe('idempotency', () => {
    /** Build a bootstrap-tolerant env backed by fakeDb (same pattern as chatWebhook tests). */
    function makeChatEnv(over: Partial<Env> = {}): {
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
        GODEPLOY_CRON_KEY: 'cron-secret',
        GOOGLE_CHAT_WEBHOOK_URL: 'https://chat.example/space-1',
        ...over,
      } as Env
      return { env, db: realDb }
    }

    function seedPendingRec(
      db: ReturnType<typeof makeFakeDb>,
      recommendation_id: string,
    ): Promise<void> {
      const row: Omit<RecommendationRow, 'created_at' | 'updated_at'> = {
        recommendation_id,
        run_id: 'run-1',
        account_id: '7705857660',
        campaign_id: 'camp-1',
        campaign_name: 'Campaign One',
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
        reason: 'r',
        guardrail_status: 'ok',
        guardrail_reason: null,
        llm_payload: null,
        llm_explanation: null,
        budget_resource_name: null,
        bidding_learning_status: null,
        status: 'pending',
        expires_at: null,
      }
      return new RecommendationsRepo(db).insert(row)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any

    beforeEach(() => {
      // Stub global fetch so GoogleChatClient.postCard returns a fake response.
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ name: 'spaces/X/messages/Y' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    it('second call does not double-post when chat_messages already has an outbound row', async () => {
      const { env, db } = makeChatEnv()
      await seedPendingRec(db, 'rec-idem-1')

      // First call: sends the card. Should result in 1 fetch + 1 outbound message row.
      const r1 = await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/send-to-chat')
      expect(r1.status).toBe(200)
      const b1 = (await r1.json()) as { sent: number; skipped: number }
      expect(b1.sent).toBe(1)
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      const messagesAfterFirst = await new ChatRepo(db).listByRecommendation('rec-idem-1')
      expect(messagesAfterFirst.length).toBe(1)
      expect(messagesAfterFirst[0]!.direction).toBe('outbound')

      // Now reset the recommendation back to 'pending' to simulate the race where
      // listByStatus would otherwise pick it up again. Idempotency must hold via
      // the chat_messages dedupe key — no second card should be posted.
      await new RecommendationsRepo(db).setStatus('rec-idem-1', 'pending')

      const r2 = await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/send-to-chat')
      expect(r2.status).toBe(200)
      const b2 = (await r2.json()) as { sent: number; skipped: number }
      expect(b2.sent).toBe(0)
      expect(b2.skipped).toBe(1)
      // fetch was NOT called a second time — no duplicate post.
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Still only one outbound message row recorded.
      const messagesAfterSecond = await new ChatRepo(db).listByRecommendation('rec-idem-1')
      expect(messagesAfterSecond.length).toBe(1)
    })
  })
})

describe('POST /cron/outcomes/24h', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 + metabase_unavailable when METABASE env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/outcomes/24h',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      computed: number
      skipped: number
      errors: string[]
    }
    expect(body.computed).toBe(0)
    expect(body.skipped).toBe(0)
    expect(body.errors).toEqual(['metabase_unavailable'])
  })
})

describe('POST /cron/outcomes/72h', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 + metabase_unavailable when METABASE env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/outcomes/72h',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      computed: number
      skipped: number
      errors: string[]
    }
    expect(body.computed).toBe(0)
    expect(body.skipped).toBe(0)
    expect(body.errors).toEqual(['metabase_unavailable'])
  })
})

describe('POST /cron/outcomes/24h — real computation', () => {
  beforeEach(() => _resetBootstrapForTests())

  /** Build an env that:
   *  - wraps fakeDb so DDL/seed are no-ops
   *  - overrides DB.query to also support the cron's range query against `executions`
   *  - stubs Metabase fetch via a globalThis.fetch spy
   */
  function makeOutcomesEnv(): {
    env: Env
    db: ReturnType<typeof makeFakeDb>
  } {
    const realDb = makeFakeDb()
    const realExec = realDb.exec.bind(realDb)
    const realQuery = realDb.query.bind(realDb)
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
      async query(sql: string, params: unknown[] = []) {
        // Custom range query the cron handler uses.
        if (/FROM\s+executions\s+WHERE\s+status\s*=\s*\?\s+AND\s+completed_at\s*>=\s*\?\s+AND\s+completed_at\s*<\s*\?/i.test(sql)) {
          const [status, lowerIso, upperIso] = params as [string, string, string]
          const execs = (realDb.tables.get('executions') ?? []).filter((r) => {
            return (
              r['status'] === status &&
              typeof r['completed_at'] === 'string' &&
              (r['completed_at'] as string) >= lowerIso &&
              (r['completed_at'] as string) < upperIso
            )
          })
          const cols = ['execution_id', 'recommendation_id', 'account_id', 'completed_at']
          return {
            columns: cols,
            rows: execs.map((r) => cols.map((c) => r[c] ?? null)),
            rowsRead: execs.length,
          }
        }
        return realQuery(sql, params)
      },
    }
    const env: Env = {
      DB: wrappedDb,
      GODEPLOY_CRON_KEY: 'cron-secret',
      METABASE_URL: 'https://metabase.example',
      METABASE_API_KEY: 'mb-key',
      METABASE_DATABASE_ID: '63',
    } as Env
    return { env, db: realDb }
  }

  function seedRec(
    db: ReturnType<typeof makeFakeDb>,
    overrides: Partial<RecommendationRow> = {},
  ): Promise<void> {
    const row: Omit<RecommendationRow, 'created_at' | 'updated_at'> = {
      recommendation_id: 'rec-out-1',
      run_id: 'run-1',
      account_id: '7705857660',
      campaign_id: '123456789',
      campaign_name: 'Pesquisa Institucional',
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
      reason: 'r',
      guardrail_status: 'ok',
      guardrail_reason: null,
      llm_payload: null,
      llm_explanation: null,
      status: 'executed',
      expires_at: null,
      ...overrides,
    } as Omit<RecommendationRow, 'created_at' | 'updated_at'>
    return new RecommendationsRepo(db).insert(row)
  }

  function seedSuccessfulExecution(
    db: ReturnType<typeof makeFakeDb>,
    completedAtIso: string,
    overrides: { execution_id?: string; recommendation_id?: string; account_id?: string } = {},
  ): void {
    const arr = db.tables.get('executions') ?? []
    arr.push({
      execution_id: overrides.execution_id ?? 'exec-1',
      recommendation_id: overrides.recommendation_id ?? 'rec-out-1',
      account_id: overrides.account_id ?? '7705857660',
      attempt_number: 1,
      status: 'success',
      google_ads_request: null,
      google_ads_response: null,
      error_message: null,
      completed_at: completedAtIso,
      created_at: completedAtIso,
    })
    db.tables.set('executions', arr)
  }

  function seedAccount(db: ReturnType<typeof makeFakeDb>): void {
    const arr = db.tables.get('accounts') ?? []
    arr.push({
      account_id: '7705857660',
      account_label: 'Apice',
      company: 'Apice',
      login_customer_id: null,
      default_chat_space_id: null,
      default_approver_emails: null,
      is_active: 1,
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
    })
    db.tables.set('accounts', arr)
  }

  function makeMetabaseFetch(cost: number, revenue: number, conversions: number) {
    return vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            cols: [{ name: 'cost' }, { name: 'revenue' }, { name: 'conversions' }],
            rows: [[cost, revenue, conversions]],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any
  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore()
  })

  it('computes a 24h outcome row from Metabase actuals', async () => {
    const { env, db } = makeOutcomesEnv()
    seedAccount(db)
    await seedRec(db)
    // Execution completed ~25h ago — lands inside the [now-30h, now-24h) band.
    const completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    seedSuccessfulExecution(db, completedAt)

    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeMetabaseFetch(8, 33, 1.5))

    const res = await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/outcomes/24h')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { computed: number; skipped: number; errors: string[] }
    expect(body.errors).toEqual([])
    expect(body.computed).toBe(1)
    expect(body.skipped).toBe(0)

    const outcomes = db.tables.get('execution_outcomes') ?? []
    expect(outcomes.length).toBe(1)
    const o = outcomes[0]!
    expect(o['window']).toBe('24h')
    expect(o['observed_cost_brl']).toBe(8)
    expect(o['observed_revenue_brl']).toBe(33)
    expect(o['observed_conversions']).toBe(1.5)
    expect(o['observed_roas']).toBeCloseTo(33 / 8)
    // expected revenue = 30, actual 33 -> +10% — within tolerance => 'as_expected'.
    const notes = JSON.parse(String(o['notes']))
    expect(notes.verdict).toBe('as_expected')
    expect(notes.company).toBe('Apice')
  })

  it('is idempotent: a second cron fire with an existing outcome row skips', async () => {
    const { env, db } = makeOutcomesEnv()
    seedAccount(db)
    await seedRec(db)
    const completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    seedSuccessfulExecution(db, completedAt)
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeMetabaseFetch(8, 33, 1.5))

    const r1 = await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/outcomes/24h')
    expect(((await r1.json()) as { computed: number }).computed).toBe(1)

    const r2 = await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/outcomes/24h')
    const b2 = (await r2.json()) as { computed: number; skipped: number }
    expect(b2.computed).toBe(0)
    expect(b2.skipped).toBe(1)
    expect((db.tables.get('execution_outcomes') ?? []).length).toBe(1)
  })

  it('classifies verdict=worse when revenue actual is far below expected', async () => {
    const { env, db } = makeOutcomesEnv()
    seedAccount(db)
    await seedRec(db)
    const completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    seedSuccessfulExecution(db, completedAt)
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeMetabaseFetch(15, 5, 0.5)) // expected revenue 30, got 5

    await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/outcomes/24h')
    const outcomes = db.tables.get('execution_outcomes') ?? []
    const notes = JSON.parse(String(outcomes[0]!['notes']))
    expect(notes.verdict).toBe('worse')
  })

  it('72h variant pulls a 4-day Data Mart range', async () => {
    const { env, db } = makeOutcomesEnv()
    seedAccount(db)
    await seedRec(db)
    // Completed ~73h ago -> inside the 72h band [now-78h, now-72h).
    const completedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString()
    seedSuccessfulExecution(db, completedAt)
    let capturedSql: string | null = null
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body))
      capturedSql = body.native.query as string
      return new Response(
        JSON.stringify({
          data: {
            cols: [{ name: 'cost' }, { name: 'revenue' }, { name: 'conversions' }],
            rows: [[40, 90, 3]],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const res = await post(env, { 'x-godeploy-cron': 'cron-secret' }, '/cron/outcomes/72h')
    const body = (await res.json()) as { computed: number; errors: string[] }
    expect(body.errors).toEqual([])
    expect(body.computed).toBe(1)
    expect(capturedSql).toMatch(/raw\.gogroup_google_ads/)
    expect(capturedSql).toMatch(/campaign_id = 123456789/)
    const outcomes = db.tables.get('execution_outcomes') ?? []
    expect(outcomes[0]!['window']).toBe('72h')
  })
})
