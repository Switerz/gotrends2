// tests/api/chatWebhook.test.ts
//
// Integration-ish tests for the Google Chat interactive webhook. We exercise
// the actual route via `worker.fetch` so the global bootstrap middleware also
// runs. The DB is a hybrid: CREATE TABLE / seed INSERTs are swallowed (so we
// don't hit the fakeDb's "unsupported SQL" guard for DDL), and the repo-shaped
// SQL falls through to the real `makeFakeDb` from tests/db/repos/_fakeDb.ts.
//
// Auth: every request carries a freshly minted RS256 JWT signed by the
// test fixture. The fixture also mocks the JWKS endpoint so `verifyChatJwt`
// resolves against the matching public key.
//
// Tests cover:
//   1. 401 when the Authorization header is missing
//   2. 401 when the JWT is malformed
//   3. 401 when the JWT has the wrong issuer / audience / signature
//   4. happy-path approve: status flips + audit rows present
//   5. happy-path reject:  status flips to 'rejected'
//   6. 404 when the recommendation id is unknown
//   7. 409 when the recommendation is already in a terminal state
//   8. 400 when the payload is malformed (missing rec parameter)
//   9. 409 idempotency: a second click on the same approved rec is rejected
//  10. auto-execute on approval, with token / without token / on failure

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import { makeFakeDb } from '../db/repos/_fakeDb'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import type { GodeployDB } from '@/db/bootstrap'
import type { RecommendationRow } from '@/db/types'
import { makeJwtFixture, makeValidChatJwt } from '../auth/_jwtFixture'
import { CHAT_ISSUER } from '@/auth/googleJwt'

// --- helpers ----------------------------------------------------------------

const APP_ORIGIN = 'https://gotrends-agent.devgogroup.com'
const AUDIENCE = `${APP_ORIGIN}/chat/webhook`

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
    APP_ORIGIN,
    ...over,
  } as Env
  return { env, db: realDb }
}

async function seedRecommendationAsync(
  db: ReturnType<typeof makeFakeDb>,
  over: Partial<RecommendationRow> = {},
): Promise<string> {
  const recId = over.recommendation_id ?? 'rec-test-1'
  const row: Omit<RecommendationRow, 'created_at' | 'updated_at'> = {
    recommendation_id: recId,
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

function buildInteractionPayload(opts: {
  action: 'approve' | 'reject'
  recommendationId: string | null
  user?: { email?: string; displayName?: string; name?: string }
  messageName?: string
  spaceName?: string
}): unknown {
  const params: Array<{ key: string; value: string }> = []
  if (opts.recommendationId !== null) {
    params.push({ key: 'rec', value: opts.recommendationId })
  }
  return {
    common: { invokedFunction: opts.action },
    action: { actionMethodName: opts.action, parameters: params },
    user: {
      email: opts.user?.email ?? 'pedro@gobeaute.com.br',
      displayName: opts.user?.displayName ?? 'Pedro Rocha',
      name: opts.user?.name ?? 'users/12345',
    },
    message: {
      name: opts.messageName ?? 'spaces/AAA/messages/BBB',
      space: { name: opts.spaceName ?? 'spaces/AAA' },
    },
  }
}

function webhookRequest(payload: unknown, init: RequestInit = {}, jwt?: string): Request {
  const baseHeaders: Record<string, string> = { 'content-type': 'application/json' }
  if (jwt) baseHeaders.authorization = `Bearer ${jwt}`
  const { headers: initHeaders, ...rest } = init
  return new Request('http://x/chat/webhook', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...rest,
    headers: { ...baseHeaders, ...((initHeaders as Record<string, string>) ?? {}) },
  } as RequestInit)
}

// --- tests ------------------------------------------------------------------

describe('POST /chat/webhook', () => {
  let fixture: Awaited<ReturnType<typeof makeJwtFixture>>
  let validJwt: string

  beforeEach(async () => {
    _resetBootstrapForTests()
    fixture = await makeJwtFixture()
    fixture.installFetchMock()
    validJwt = await makeValidChatJwt(fixture, AUDIENCE)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 401 when the Authorization header is missing', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' })),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('unauthorized')
    expect(body.detail).toMatch(/missing bearer/)
  })

  it('returns 401 when the JWT is malformed', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
        {},
        'this.is.not-a-real-jwt',
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the JWT has the wrong issuer', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db)
    const now = Math.floor(Date.now() / 1000)
    const wrongIss = await fixture.signJwt({
      iss: 'someone-else@evil.example',
      aud: AUDIENCE,
      iat: now,
      exp: now + 60,
    })
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
        {},
        wrongIss,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the JWT has the wrong audience', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db)
    const now = Math.floor(Date.now() / 1000)
    const wrongAud = await fixture.signJwt({
      iss: CHAT_ISSUER,
      aud: 'https://other.example/chat/webhook',
      iat: now,
      exp: now + 60,
    })
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
        {},
        wrongAud,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })

  it('approve happy path: flips status to approved + writes approval + chat_messages', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db, { recommendation_id: 'rec-approve' })

    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-approve' }),
        {},
        validJwt,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)

    const recRow = db.tables
      .get('recommendations')
      ?.find((r) => r['recommendation_id'] === 'rec-approve')
    expect(recRow?.['status']).toBe('approved')

    const approvals = db.tables.get('approvals') ?? []
    expect(approvals.length).toBe(1)
    expect(approvals[0]!['decision']).toBe('approved')
    expect(approvals[0]!['decided_via']).toBe('google_chat')
    expect(approvals[0]!['decided_by']).toBe('pedro@gobeaute.com.br')
    expect(approvals[0]!['account_id']).toBe('7705857660')
    const note = JSON.parse(String(approvals[0]!['note']))
    expect(note.displayName).toBe('Pedro Rocha')
    expect(note.chatUserId).toBe('users/12345')
    expect(note.chatMessageName).toBe('spaces/AAA/messages/BBB')

    const chatRows = db.tables.get('chat_messages') ?? []
    expect(chatRows.length).toBe(1)
    expect(chatRows[0]!['direction']).toBe('inbound')
    expect(chatRows[0]!['recommendation_id']).toBe('rec-approve')
    expect(chatRows[0]!['space_id']).toBe('spaces/AAA')
  })

  it('reject happy path: flips status to rejected', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db, { recommendation_id: 'rec-reject' })

    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'reject', recommendationId: 'rec-reject' }),
        {},
        validJwt,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { text: string }
    expect(body.text).toMatch(/Rejeitado/)

    const recRow = db.tables.get('recommendations')?.find((r) => r['recommendation_id'] === 'rec-reject')
    expect(recRow?.['status']).toBe('rejected')

    const approvals = db.tables.get('approvals') ?? []
    expect(approvals[0]!['decision']).toBe('rejected')
  })

  it('returns 404 when the recommendation does not exist', async () => {
    const { env } = makeBootstrapTolerantEnv()
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-missing' }),
        {},
        validJwt,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'recommendation_not_found' })
  })

  it('returns 409 when the recommendation is already in a terminal state', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db, {
      recommendation_id: 'rec-terminal',
      status: 'executed',
    })
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-terminal' }),
        {},
        validJwt,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; currentStatus: string }
    expect(body.error).toBe('recommendation_not_pending')
    expect(body.currentStatus).toBe('executed')
  })

  it('returns 400 when the payload is malformed (missing rec parameter)', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: null }),
        {},
        validJwt,
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('invalid_event')
    expect(body.detail).toMatch(/missing rec parameter/i)
  })

  it('returns 400 when the body is not valid JSON', async () => {
    const { env } = makeBootstrapTolerantEnv()
    const res = await worker.fetch(
      webhookRequest('not-json-{', { headers: {} }, validJwt),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_json' })
  })

  it('idempotency: a second click after approval returns 409', async () => {
    const { env, db } = makeBootstrapTolerantEnv()
    await seedRecommendationAsync(db, { recommendation_id: 'rec-double' })
    const payload = buildInteractionPayload({ action: 'approve', recommendationId: 'rec-double' })

    const first = await worker.fetch(
      webhookRequest(payload, {}, validJwt),
      env,
      {} as ExecutionContext,
    )
    expect(first.status).toBe(200)
    const second = await worker.fetch(
      webhookRequest(payload, {}, validJwt),
      env,
      {} as ExecutionContext,
    )
    expect(second.status).toBe(409)
    expect((db.tables.get('approvals') ?? []).length).toBe(1)
  })

  describe('auto-execute on approval', () => {
    it('fires POST /api/execute/<id> with X-Execute-Token when EXECUTE_TOKEN is set and decision=approved', async () => {
      const { env, db } = makeBootstrapTolerantEnv({
        EXECUTE_TOKEN: 'exec-tok',
      })
      await seedRecommendationAsync(db, { recommendation_id: 'rec-auto-exec' })

      // Track calls to /api/execute by extending the existing fetch mock.
      const executeCalls: Array<{ url: string; init: RequestInit | undefined }> = []
      const realMock = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/api/execute/')) {
          executeCalls.push({ url, init })
          return new Response('{}', { status: 200 })
        }
        return realMock(input, init)
      })

      const res = await worker.fetch(
        webhookRequest(
          buildInteractionPayload({ action: 'approve', recommendationId: 'rec-auto-exec' }),
          {},
          validJwt,
        ),
        env,
        {} as ExecutionContext,
      )
      expect(res.status).toBe(200)
      expect(executeCalls).toHaveLength(1)
      expect(executeCalls[0]!.url).toMatch(/\/api\/execute\/rec-auto-exec$/)
      const headers = (executeCalls[0]!.init?.headers ?? {}) as Record<string, string>
      expect(headers['x-execute-token']).toBe('exec-tok')
    })

    it('does not fire /api/execute when EXECUTE_TOKEN is not set', async () => {
      const { env, db } = makeBootstrapTolerantEnv()
      await seedRecommendationAsync(db, { recommendation_id: 'rec-no-token' })

      const executeCalls: string[] = []
      const realMock = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/api/execute/')) {
          executeCalls.push(url)
          return new Response('{}', { status: 200 })
        }
        return realMock(input, init)
      })

      const res = await worker.fetch(
        webhookRequest(
          buildInteractionPayload({ action: 'approve', recommendationId: 'rec-no-token' }),
          {},
          validJwt,
        ),
        env,
        {} as ExecutionContext,
      )
      expect(res.status).toBe(200)
      expect(executeCalls).toEqual([])
    })

    it('does not fire /api/execute on rejection', async () => {
      const { env, db } = makeBootstrapTolerantEnv({ EXECUTE_TOKEN: 'exec-tok' })
      await seedRecommendationAsync(db, { recommendation_id: 'rec-reject-noexec' })

      const executeCalls: string[] = []
      const realMock = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/api/execute/')) {
          executeCalls.push(url)
          return new Response('{}', { status: 200 })
        }
        return realMock(input, init)
      })

      const res = await worker.fetch(
        webhookRequest(
          buildInteractionPayload({ action: 'reject', recommendationId: 'rec-reject-noexec' }),
          {},
          validJwt,
        ),
        env,
        {} as ExecutionContext,
      )
      expect(res.status).toBe(200)
      expect(executeCalls).toEqual([])
    })

    it('swallows execute failures and still returns 200 to Chat', async () => {
      const { env, db } = makeBootstrapTolerantEnv({ EXECUTE_TOKEN: 'exec-tok' })
      await seedRecommendationAsync(db, { recommendation_id: 'rec-exec-fail' })

      const realMock = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/api/execute/')) {
          throw new Error('network down')
        }
        return realMock(input, init)
      })

      const res = await worker.fetch(
        webhookRequest(
          buildInteractionPayload({ action: 'approve', recommendationId: 'rec-exec-fail' }),
          {},
          validJwt,
        ),
        env,
        {} as ExecutionContext,
      )
      expect(res.status).toBe(200)
      const recRow = db.tables
        .get('recommendations')
        ?.find((r) => r['recommendation_id'] === 'rec-exec-fail')
      expect(recRow?.['status']).toBe('approved')
    })
  })
})
