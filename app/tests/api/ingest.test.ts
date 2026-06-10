// tests/api/ingest.test.ts
//
// HTTP tests for POST /api/ingest/run. Verifies auth, request validation, and
// the run/recommendations write path that funnels every candidate through the
// refiner (persistDecision).
//
// We use a recording fake DB: it stores every (sql, params) tuple so we can
// assert on the shape of the writes without needing a real SQL engine.

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'

interface Write {
  sql: string
  params: unknown[]
}

interface RecordingDB extends GodeployDB {
  writes: Write[]
}

function makeEnv(): { env: Env; db: RecordingDB } {
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
  return { env: { DB: db, INGEST_TOKEN: 'secret' } as Env, db }
}

const VALID_CAND = {
  account_id: 'acc-1',
  campaign_id: 'c-1',
  campaign_name: 'Search NB',
  skill_type: 'budget_reallocation',
  recommended_action: 'increase_budget',
  change_percent: 0.1,
  current_budget_brl: 1000,
  current_target_roas: null,
  expected_marginal_roas: 3,
  confidence_score: 80,
  risk_level: 'medium',
  reason: 'test',
}

const post = (env: Env, headers: Record<string, string>, body: unknown) =>
  worker.fetch(
    new Request('http://x/api/ingest/run', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  )

describe('POST /api/ingest/run', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 401 when no ingest token is provided', async () => {
    const { env } = makeEnv()
    const res = await post(env, { 'content-type': 'application/json' }, {
      accountId: 'acc-1',
      pipelineVersion: '0.1.0',
      candidates: [],
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when the ingest token is wrong', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'content-type': 'application/json', 'x-ingest-token': 'wrong' },
      { accountId: 'acc-1', pipelineVersion: '0.1.0', candidates: [] },
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when the body is missing required fields', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'content-type': 'application/json', 'x-ingest-token': 'secret' },
      { accountId: 'acc-1' /* missing pipelineVersion + candidates */ },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_required_fields' })
  })

  it('returns 400 when the body is not JSON', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'content-type': 'application/json', 'x-ingest-token': 'secret' },
      'not-json-{',
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_json' })
  })

  it('happy path persists the run + every refined recommendation', async () => {
    const { env, db } = makeEnv()
    const res = await post(
      env,
      { 'content-type': 'application/json', 'x-ingest-token': 'secret' },
      {
        accountId: 'acc-1',
        pipelineVersion: '0.1.0',
        candidates: [VALID_CAND, { ...VALID_CAND, campaign_id: 'c-2' }],
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string; nIngested: number; nErrors: number }
    expect(body.nIngested).toBe(2)
    expect(body.nErrors).toBe(0)
    expect(typeof body.runId).toBe('string')

    // Exactly one INSERT into model_runs.
    const modelRunInserts = db.writes.filter((w) => /INSERT INTO model_runs\b/.test(w.sql))
    expect(modelRunInserts).toHaveLength(1)
    expect(modelRunInserts[0]!.params[0]).toBe(body.runId) // run_id
    expect(modelRunInserts[0]!.params[1]).toBe('acc-1') // account_id
    expect(modelRunInserts[0]!.params[3]).toBe('running') // status

    // Exactly two INSERTs into recommendations.
    const recInserts = db.writes.filter((w) => /INSERT INTO recommendations\b/.test(w.sql))
    expect(recInserts).toHaveLength(2)

    // Final UPDATE marks the run successful with count metadata.
    const update = db.writes.find((w) => /UPDATE model_runs SET status = \?/.test(w.sql))
    expect(update).toBeDefined()
    expect(update!.params).toEqual(['success', 2, 2, body.runId])
  })

  it('reports partial status when at least one candidate fails refine()', async () => {
    const { env, db } = makeEnv()
    const res = await post(
      env,
      { 'content-type': 'application/json', 'x-ingest-token': 'secret' },
      {
        accountId: 'acc-1',
        pipelineVersion: '0.1.0',
        candidates: [
          VALID_CAND,
          { ...VALID_CAND, recommended_action: 'lol' }, // invalid enum → CandidateInvalid
        ],
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nIngested: number; nErrors: number; errors: string[] }
    expect(body.nIngested).toBe(1)
    expect(body.nErrors).toBe(1)
    expect(body.errors).toHaveLength(1)

    const update = db.writes.find((w) => /UPDATE model_runs SET status = \?/.test(w.sql))
    expect(update).toBeDefined()
    expect(update!.params[0]).toBe('partial')
    expect(update!.params[1]).toBe(2) // n_campaigns_scanned (input count)
    expect(update!.params[2]).toBe(1) // n_recommendations (successful refines)
  })

  it('uses the client-provided runId when present', async () => {
    const { env, db } = makeEnv()
    const explicitId = 'fixed-run-id'
    const res = await post(
      env,
      { 'content-type': 'application/json', 'x-ingest-token': 'secret' },
      {
        runId: explicitId,
        accountId: 'acc-1',
        pipelineVersion: '0.1.0',
        candidates: [VALID_CAND],
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string }
    expect(body.runId).toBe(explicitId)

    const modelRunInsert = db.writes.find((w) => /INSERT INTO model_runs\b/.test(w.sql))
    expect(modelRunInsert!.params[0]).toBe(explicitId)
  })
})
