// tests/api/execute.test.ts
//
// Coverage for POST /api/execute/:id (Task 5.4):
//   1. 404 when recommendation missing
//   2. 409 when status='pending' (not yet approved)
//   3. 409 when status='executed' (already done — idempotency guard)
//   4. 409 when guardrail_status='blocked'
//   5. 500 when env missing Google Ads creds
//   6. happy budget mutate (increase_budget)
//   7. happy target_roas mutate (increase_troas_or_reduce_budget)
//   8. 502 when ads client throws — execution=failed, rec.status='failed'
//   9. attempt_number increments on retry after a previous failed execution
//
// We inject a fake GoogleAdsClient via `executeRouterFactory(clientFactory)`,
// mount a minimal Hono app, and back it with the in-memory fakeDb the repo
// round-trip tests use. The bootstrap middleware is bypassed by going directly
// against the router (no `worker.fetch`).

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { GoogleAdsClient } from '@/clients/googleAds'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import type { GuardrailStatus, RecommendationRow, RecommendationStatus } from '@/db/types'
import {
  buildGoogleAdsClient,
  executeRouterFactory,
} from '@/http/routes/execute'
import type { Env } from '@/index'
import { makeFakeDb } from '../db/repos/_fakeDb'

const REC_ID = '00000000-0000-4000-8000-00000000aaaa'
const ACCOUNT_ID = '7705857660'
const CAMPAIGN_ID = 'c-001'
const TEST_EXECUTE_TOKEN = 'test-execute-token'

function baseRow(
  overrides: Partial<RecommendationRow> = {},
): Omit<RecommendationRow, 'created_at' | 'updated_at'> {
  return {
    recommendation_id: REC_ID,
    run_id: '00000000-0000-4000-8000-00000000bbbb',
    account_id: ACCOUNT_ID,
    campaign_id: CAMPAIGN_ID,
    campaign_name: 'Search NB',
    skill_type: 'budget_reallocation',
    recommended_action: 'increase_budget',
    change_percent: 0.1,
    current_budget_brl: 1000,
    proposed_budget_brl: 1100,
    current_target_roas: null,
    proposed_target_roas: null,
    expected_incremental_cost_brl: 100,
    expected_incremental_revenue_brl: 350,
    expected_marginal_roas: 3.5,
    projected_cos: 0.28,
    confidence_score: 80,
    risk_level: 'low',
    reason: 'positive marginal ROAS',
    guardrail_status: 'ok' as GuardrailStatus,
    guardrail_reason: null,
    llm_payload: null,
    llm_explanation: null,
    status: 'approved' as RecommendationStatus,
    expires_at: null,
    ...overrides,
  }
}

interface FakeClient {
  budgetCalls: Array<{ customerId: string; budgetResource: string; amountMicros: number }>
  roasCalls: Array<{ customerId: string; campaignResource: string; targetRoas: number }>
  client: GoogleAdsClient
}

function makeFakeClient(opts: { throwOnMutate?: boolean } = {}): FakeClient {
  const budgetCalls: FakeClient['budgetCalls'] = []
  const roasCalls: FakeClient['roasCalls'] = []
  const client = {
    async mutateBudget(customerId: string, budgetResource: string, amountMicros: number) {
      budgetCalls.push({ customerId, budgetResource, amountMicros })
      if (opts.throwOnMutate) throw new Error('boom: ads API down')
      return { resourceName: `${budgetResource}` }
    },
    async mutateCampaignTargetRoas(
      customerId: string,
      campaignResource: string,
      targetRoas: number,
    ) {
      roasCalls.push({ customerId, campaignResource, targetRoas })
      if (opts.throwOnMutate) throw new Error('boom: ads API down')
      return { resourceName: `${campaignResource}` }
    },
  } as unknown as GoogleAdsClient
  return { budgetCalls, roasCalls, client }
}

async function setupApp(opts: {
  row?: Omit<RecommendationRow, 'created_at' | 'updated_at'> | null
  fakeClient?: GoogleAdsClient | null
  /** When true, drive the default factory (env-based) rather than injecting a client. */
  useDefaultFactory?: boolean
  /** When true, omit EXECUTE_TOKEN from env (used to test 500 fail-closed). */
  omitExecuteToken?: boolean
}) {
  const db = makeFakeDb()
  if (opts.row) {
    const recsRepo = new RecommendationsRepo(db)
    await recsRepo.insert(opts.row)
  }
  const env = {
    DB: db,
    ...(opts.omitExecuteToken ? {} : { EXECUTE_TOKEN: TEST_EXECUTE_TOKEN }),
  } as unknown as Env
  const factory = opts.useDefaultFactory
    ? buildGoogleAdsClient
    : () => opts.fakeClient ?? null
  const router = executeRouterFactory(factory)
  const app = new Hono<{ Bindings: Env }>()
  app.route('/api/execute', router)
  return { app, env, db }
}

async function post(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  id: string,
  opts: { omitToken?: boolean; token?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (!opts.omitToken) {
    headers['x-execute-token'] = opts.token ?? TEST_EXECUTE_TOKEN
  }
  return app.fetch(
    new Request(`http://x/api/execute/${id}`, { method: 'POST', headers }),
    env,
  )
}

describe('POST /api/execute/:id', () => {
  it('404 when the recommendation does not exist', async () => {
    const { app, env } = await setupApp({ row: null, fakeClient: makeFakeClient().client })
    const res = await post(app, env, 'does-not-exist')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'recommendation_not_found' })
  })

  it('409 when the recommendation is still pending (not approved)', async () => {
    const { app, env } = await setupApp({
      row: baseRow({ status: 'pending' }),
      fakeClient: makeFakeClient().client,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_approved', currentStatus: 'pending' })
  })

  it('409 when the recommendation has already been executed', async () => {
    const { app, env } = await setupApp({
      row: baseRow({ status: 'executed' }),
      fakeClient: makeFakeClient().client,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'already_executed_or_in_progress',
      currentStatus: 'executed',
    })
  })

  it('409 when the recommendation is blocked by guardrails', async () => {
    const { app, env } = await setupApp({
      row: baseRow({ guardrail_status: 'blocked', guardrail_reason: 'cap exceeded' }),
      fakeClient: makeFakeClient().client,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'blocked_by_guardrail',
      reason: 'cap exceeded',
    })
  })

  it('500 when Google Ads env secrets are missing', async () => {
    // Drive the real env-based factory with an empty env => returns null.
    const { app, env } = await setupApp({
      row: baseRow(),
      useDefaultFactory: true,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'env_missing' })
    // No execution row should have been inserted.
    const { rows } = await env.DB.query('SELECT * FROM executions')
    expect(rows.length).toBe(0)
  })

  it('happy budget mutate — calls ads.mutateBudget and marks success', async () => {
    const fake = makeFakeClient()
    const { app, env, db } = await setupApp({
      row: baseRow({ proposed_budget_brl: 1234.56 }),
      fakeClient: fake.client,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { executionId: string; status: string; resourceName: string }
    expect(body.status).toBe('success')
    expect(body.executionId).toMatch(/^[0-9a-f-]{36}$/)

    // mutateBudget called with expected args
    expect(fake.budgetCalls.length).toBe(1)
    expect(fake.budgetCalls[0]).toEqual({
      customerId: ACCOUNT_ID,
      budgetResource: `customers/${ACCOUNT_ID}/campaignBudgets/${CAMPAIGN_ID}_budget`,
      amountMicros: Math.round(1234.56 * 1_000_000),
    })
    expect(fake.roasCalls.length).toBe(0)

    // executions row → success with serialized request/response
    const execs = db.tables.get('executions') ?? []
    expect(execs.length).toBe(1)
    expect(execs[0]!.status).toBe('success')
    expect(execs[0]!.attempt_number).toBe(1)
    expect(execs[0]!.completed_at).toBeTruthy()
    expect(typeof execs[0]!.google_ads_request).toBe('string')
    expect(typeof execs[0]!.google_ads_response).toBe('string')

    // recommendations.status → executed
    const recs = db.tables.get('recommendations') ?? []
    expect(recs[0]!.status).toBe('executed')
  })

  it('happy target_roas mutate — calls ads.mutateCampaignTargetRoas and marks success', async () => {
    const fake = makeFakeClient()
    const { app, env, db } = await setupApp({
      row: baseRow({
        recommended_action: 'increase_troas_or_reduce_budget',
        current_target_roas: 3.0,
        proposed_target_roas: 3.5,
        proposed_budget_brl: null,
      }),
      fakeClient: fake.client,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('success')

    expect(fake.roasCalls.length).toBe(1)
    expect(fake.roasCalls[0]).toEqual({
      customerId: ACCOUNT_ID,
      campaignResource: `customers/${ACCOUNT_ID}/campaigns/${CAMPAIGN_ID}`,
      targetRoas: 3.5,
    })
    expect(fake.budgetCalls.length).toBe(0)

    const execs = db.tables.get('executions') ?? []
    expect(execs[0]!.status).toBe('success')
    const recs = db.tables.get('recommendations') ?? []
    expect(recs[0]!.status).toBe('executed')
  })

  it('502 when the ads client throws — execution=failed, rec.status=failed', async () => {
    const fake = makeFakeClient({ throwOnMutate: true })
    const { app, env, db } = await setupApp({
      row: baseRow(),
      fakeClient: fake.client,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { status: string; error: string }
    expect(body.status).toBe('failed')
    expect(body.error).toContain('boom')

    const execs = db.tables.get('executions') ?? []
    expect(execs.length).toBe(1)
    expect(execs[0]!.status).toBe('failed')
    expect(String(execs[0]!.error_message)).toContain('mutate_failed')
    expect(String(execs[0]!.error_message)).toContain('boom')

    const recs = db.tables.get('recommendations') ?? []
    expect(recs[0]!.status).toBe('failed')
  })

  it('attempt_number increments when the recommendation is retried', async () => {
    const fake = makeFakeClient({ throwOnMutate: true })
    const { app, env, db } = await setupApp({
      row: baseRow(),
      fakeClient: fake.client,
    })
    // First attempt → failed.
    const r1 = await post(app, env, REC_ID)
    expect(r1.status).toBe(502)
    // Reset rec back to 'approved' so the executor will accept a retry.
    const recsRepo = new RecommendationsRepo(env.DB)
    await recsRepo.setStatus(REC_ID, 'approved')

    // Second attempt → still failing (same fake), but a NEW execution row
    // with attempt_number=2 must be recorded.
    const r2 = await post(app, env, REC_ID)
    expect(r2.status).toBe(502)

    const execs = db.tables.get('executions') ?? []
    expect(execs.length).toBe(2)
    const attempts = execs.map((r) => r.attempt_number).sort()
    expect(attempts).toEqual([1, 2])
  })

  it('401 without execute token', async () => {
    const { app, env } = await setupApp({
      row: baseRow(),
      fakeClient: makeFakeClient().client,
    })
    const res = await post(app, env, REC_ID, { omitToken: true })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  // ---------------------------------------------------------------------------
  // DRY_RUN_EXECUTE='1' — executor builds the request, logs it, writes a
  // success execution row, but does NOT call the ads client. Used to smoke
  // the approval loop end-to-end on first deploys without mutating real
  // campaigns.
  // ---------------------------------------------------------------------------
  it('DRY_RUN_EXECUTE=1 skips budget mutate but still records success', async () => {
    const fake = makeFakeClient()
    const { app, env, db } = await setupApp({
      row: baseRow({ proposed_budget_brl: 1234.56 }),
      fakeClient: fake.client,
    })
    ;(env as Env & { DRY_RUN_EXECUTE?: string }).DRY_RUN_EXECUTE = '1'

    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      executionId: string
      status: string
      resourceName: string
      dryRun?: boolean
    }
    expect(body.status).toBe('success')
    expect(body.dryRun).toBe(true)
    expect(body.resourceName.startsWith('[dry_run] ')).toBe(true)

    // The ads client must NOT have been invoked.
    expect(fake.budgetCalls.length).toBe(0)
    expect(fake.roasCalls.length).toBe(0)

    // The execution row should be 'success' and carry the dry-run marker in
    // the persisted google_ads_response payload.
    const execs = db.tables.get('executions') ?? []
    expect(execs.length).toBe(1)
    expect(execs[0]!.status).toBe('success')
    expect(execs[0]!.attempt_number).toBe(1)
    expect(execs[0]!.completed_at).toBeTruthy()
    const responseJson = JSON.parse(String(execs[0]!.google_ads_response)) as {
      dry_run?: boolean
      resourceName: string
    }
    expect(responseJson.dry_run).toBe(true)
    expect(responseJson.resourceName.startsWith('[dry_run] ')).toBe(true)
    // Request payload must still be persisted exactly as we WOULD have sent.
    const requestJson = JSON.parse(String(execs[0]!.google_ads_request)) as {
      kind: string
      amountMicros: number
    }
    expect(requestJson.kind).toBe('mutateBudget')
    expect(requestJson.amountMicros).toBe(Math.round(1234.56 * 1_000_000))

    // Recommendation transitions to 'executed' as in the real path.
    const recs = db.tables.get('recommendations') ?? []
    expect(recs[0]!.status).toBe('executed')
  })

  it('DRY_RUN_EXECUTE=1 skips target_roas mutate but still records success', async () => {
    const fake = makeFakeClient()
    const { app, env, db } = await setupApp({
      row: baseRow({
        recommended_action: 'increase_troas_or_reduce_budget',
        current_target_roas: 3.0,
        proposed_target_roas: 3.5,
        proposed_budget_brl: null,
      }),
      fakeClient: fake.client,
    })
    ;(env as Env & { DRY_RUN_EXECUTE?: string }).DRY_RUN_EXECUTE = '1'

    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; dryRun?: boolean }
    expect(body.status).toBe('success')
    expect(body.dryRun).toBe(true)

    expect(fake.roasCalls.length).toBe(0)
    expect(fake.budgetCalls.length).toBe(0)

    const execs = db.tables.get('executions') ?? []
    expect(execs[0]!.status).toBe('success')
    const responseJson = JSON.parse(String(execs[0]!.google_ads_response)) as {
      dry_run?: boolean
    }
    expect(responseJson.dry_run).toBe(true)

    const recs = db.tables.get('recommendations') ?? []
    expect(recs[0]!.status).toBe('executed')
  })

  it('DRY_RUN_EXECUTE unset → real mutate path still runs', async () => {
    const fake = makeFakeClient()
    const { app, env, db } = await setupApp({
      row: baseRow({ proposed_budget_brl: 500 }),
      fakeClient: fake.client,
    })
    // Explicitly do NOT set DRY_RUN_EXECUTE.
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dryRun?: boolean }
    expect(body.dryRun).toBeUndefined()
    expect(fake.budgetCalls.length).toBe(1)
    const execs = db.tables.get('executions') ?? []
    const responseJson = JSON.parse(String(execs[0]!.google_ads_response)) as {
      dry_run?: boolean
    }
    expect(responseJson.dry_run).toBeUndefined()
  })

  it('DRY_RUN_EXECUTE="0" (string) is NOT treated as dry-run', async () => {
    const fake = makeFakeClient()
    const { app, env } = await setupApp({
      row: baseRow({ proposed_budget_brl: 500 }),
      fakeClient: fake.client,
    })
    ;(env as Env & { DRY_RUN_EXECUTE?: string }).DRY_RUN_EXECUTE = '0'
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(200)
    expect(fake.budgetCalls.length).toBe(1)
  })

  it('500 server_misconfigured when EXECUTE_TOKEN env missing', async () => {
    const { app, env } = await setupApp({
      row: baseRow(),
      fakeClient: makeFakeClient().client,
      omitExecuteToken: true,
    })
    const res = await post(app, env, REC_ID)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'server_misconfigured',
      detail: 'EXECUTE_TOKEN not set',
    })
  })
})
