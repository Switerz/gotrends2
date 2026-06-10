// src/http/routes/ingest.ts
//
// Write endpoint that lets the legacy Python pipeline (or any external tool)
// push a model_run + a batch of refined candidates in a single POST. Every
// candidate funnels through `persistDecision` so the refiner gate is the only
// way recommendations land in the DB.
//
// Protected by `requireIngestToken` — the only writeable HTTP surface in
// Phase 5.2.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { requireIngestToken } from '../middleware'
import { persistDecision } from '@/agent/tools/persistDecision'
import { uuid } from '@/lib/uuid'

export const ingestRouter = new Hono<{ Bindings: Env }>()

ingestRouter.use('*', requireIngestToken)

interface IngestRunPayload {
  /** Optional — server generates a UUID if absent. */
  runId?: string
  accountId: string
  pipelineVersion: string
  inputWindowStart?: string | null
  inputWindowEnd?: string | null
  /** Each candidate is validated by refine() before insert. */
  candidates: unknown[]
}

// POST /api/ingest/run
ingestRouter.post('/run', async (c) => {
  let body: IngestRunPayload
  try {
    body = (await c.req.json()) as IngestRunPayload
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (
    !body.accountId ||
    !body.pipelineVersion ||
    !Array.isArray(body.candidates)
  ) {
    return c.json({ error: 'missing_required_fields' }, 400)
  }

  const runId = body.runId ?? uuid()

  // Insert the run row up front in 'running' state.
  await c.env.DB.exec(
    `INSERT INTO model_runs (run_id, account_id, pipeline_version, status, n_campaigns_scanned, n_recommendations, input_window_start, input_window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      body.accountId,
      body.pipelineVersion,
      'running',
      null,
      null,
      body.inputWindowStart ?? null,
      body.inputWindowEnd ?? null,
    ],
  )

  let nRecs = 0
  const errors: string[] = []
  for (const cand of body.candidates) {
    try {
      await persistDecision(c.env.DB, cand, {
        runId,
        recommendationId: uuid(),
      })
      nRecs++
    } catch (e) {
      errors.push((e as Error).message)
    }
  }

  // Mark the run terminal. 'success' if everything refined cleanly, 'partial'
  // if at least one candidate failed refine() (the rest were still persisted).
  const status = errors.length === 0 ? 'success' : 'partial'
  await c.env.DB.exec(
    `UPDATE model_runs SET status = ?, n_campaigns_scanned = ?, n_recommendations = ? WHERE run_id = ?`,
    [status, body.candidates.length, nRecs, runId],
  )

  return c.json(
    { runId, nIngested: nRecs, nErrors: errors.length, errors },
    200,
  )
})
