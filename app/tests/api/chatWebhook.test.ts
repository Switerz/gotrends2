// tests/api/chatWebhook.test.ts
//
// Integration-ish tests for the Google Chat interactive webhook. We exercise
// the actual route via `worker.fetch` so the global bootstrap middleware also
// runs. The DB is a hybrid: CREATE TABLE / seed INSERTs are swallowed (so we
// don't hit the fakeDb's "unsupported SQL" guard for DDL), and the repo-shaped
// SQL falls through to the real `makeFakeDb` from tests/db/repos/_fakeDb.ts.
//
// Tests cover:
//   1. 401 when verification token is set but the request omits it
//   2. 200 OK when the env var is absent (dev mode degrades open)
//   3. happy-path approve: status flips to 'approved' + audit rows present
//   4. happy-path reject:  status flips to 'rejected'
//   5. 404 when the recommendation id is unknown
//   6. 409 when the recommendation is already in a terminal state
//   7. 400 when the payload is malformed (missing rec parameter)
//   8. 409 idempotency: a second click on the same approved rec is rejected

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import { makeFakeDb } from '../db/repos/_fakeDb'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import type { GodeployDB } from '@/db/bootstrap'
import type { RecommendationRow } from '@/db/types'

// --- helpers ----------------------------------------------------------------

/**
 * Build an Env whose `DB` is the full fakeDb engine but whose `exec()` first
 * intercepts DDL + seed-style statements (which the fakeDb doesn't understand)
 * and lets every other repo-shaped SQL fall through to the real engine.
 */
function makeBootstrapTolerantEnv(over: Partial<Env> = {}): {
  env: Env
  db: ReturnType<typeof makeFakeDb>
} {
  const realDb = makeFakeDb()
  const realExec = realDb.exec.bind(realDb)
  const wrappedDb: GodeployDB = {
    async exec(sql: string, params?: unknown[]) {
      const head = sql.trim().toUpperCase()
      // Bootstrap-only statements the fakeDb engine doesn't model: DDL, PRAGMAs,
      // and the seed inserts (`INSERT OR IGNORE` / `INSERT OR REPLACE`). Swallow
      // them so tests focus on the route's repo-shaped writes only.
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
    ...over,
  } as Env
  // expose the underlying fakeDb so tests can poke at .tables
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

/** Build an interaction payload mirroring what Google Chat sends. */
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

function webhookRequest(payload: unknown, init: RequestInit = {}): Request {
  return new Request('http://x/chat/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...init,
  } as RequestInit)
}

// --- tests ------------------------------------------------------------------

describe('POST /chat/webhook', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 401 when GOOGLE_CHAT_VERIFICATION_TOKEN is set and the header is missing', async () => {
    const { env, db } = makeBootstrapTolerantEnv({
      GOOGLE_CHAT_VERIFICATION_TOKEN: 's3cret',
    })
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns 500 server_misconfigured when both token and dev opt-in are absent (fail-closed)', async () => {
    const { env, db } = makeBootstrapTolerantEnv() // no token, no opt-in
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('server_misconfigured')
    expect(body.detail).toMatch(/GOOGLE_CHAT_VERIFICATION_TOKEN/)
  })

  it('returns 200 when ALLOW_UNAUTHENTICATED_CHAT=1 (explicit dev opt-in)', async () => {
    const { env, db } = makeBootstrapTolerantEnv({
      ALLOW_UNAUTHENTICATED_CHAT: '1',
    })
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actionResponse: { type: string } }
    expect(body.actionResponse.type).toBe('UPDATE_MESSAGE')
  })

  it('approve happy path: flips status to approved + writes approval + chat_messages', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    await seedRecommendationAsync(db, { recommendation_id: 'rec-approve' })

    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-approve' }),
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)

    // Recommendation status updated.
    const recRow = db.tables.get('recommendations')?.find((r) => r['recommendation_id'] === 'rec-approve')
    expect(recRow?.['status']).toBe('approved')

    // Approval row written.
    const approvals = db.tables.get('approvals') ?? []
    expect(approvals.length).toBe(1)
    expect(approvals[0]!['decision']).toBe('approved')
    expect(approvals[0]!['decided_via']).toBe('google_chat')
    expect(approvals[0]!['decided_by']).toBe('pedro@gobeaute.com.br')
    expect(approvals[0]!['account_id']).toBe('7705857660')
    // Note carries chat-user metadata as JSON.
    const note = JSON.parse(String(approvals[0]!['note']))
    expect(note.displayName).toBe('Pedro Rocha')
    expect(note.chatUserId).toBe('users/12345')
    expect(note.chatMessageName).toBe('spaces/AAA/messages/BBB')

    // Chat message row written (inbound).
    const chatRows = db.tables.get('chat_messages') ?? []
    expect(chatRows.length).toBe(1)
    expect(chatRows[0]!['direction']).toBe('inbound')
    expect(chatRows[0]!['recommendation_id']).toBe('rec-approve')
    expect(chatRows[0]!['space_id']).toBe('spaces/AAA')
  })

  it('reject happy path: flips status to rejected', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    await seedRecommendationAsync(db, { recommendation_id: 'rec-reject' })

    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'reject', recommendationId: 'rec-reject' }),
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
    const { env } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-missing' }),
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'recommendation_not_found' })
  })

  it('returns 409 when the recommendation is already in a terminal state', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    await seedRecommendationAsync(db, {
      recommendation_id: 'rec-terminal',
      status: 'executed',
    })
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-terminal' }),
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
    const { env, db } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: null }),
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
    const { env } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    const res = await worker.fetch(
      webhookRequest('not-json-{', { headers: {} }),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_json' })
  })

  it('idempotency: a second click after approval returns 409', async () => {
    const { env, db } = makeBootstrapTolerantEnv({ ALLOW_UNAUTHENTICATED_CHAT: '1' })
    await seedRecommendationAsync(db, { recommendation_id: 'rec-double' })
    const payload = buildInteractionPayload({ action: 'approve', recommendationId: 'rec-double' })

    const first = await worker.fetch(webhookRequest(payload), env, {} as ExecutionContext)
    expect(first.status).toBe(200)
    const second = await worker.fetch(webhookRequest(payload), env, {} as ExecutionContext)
    expect(second.status).toBe(409)
    // Only one approval row written.
    expect((db.tables.get('approvals') ?? []).length).toBe(1)
  })

  it('accepts the verification token via Authorization: Bearer header', async () => {
    const { env, db } = makeBootstrapTolerantEnv({
      GOOGLE_CHAT_VERIFICATION_TOKEN: 's3cret',
    })
    await seedRecommendationAsync(db)
    const res = await worker.fetch(
      webhookRequest(
        buildInteractionPayload({ action: 'approve', recommendationId: 'rec-test-1' }),
        { headers: { authorization: 'Bearer s3cret' } },
      ),
      env,
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
  })
})

