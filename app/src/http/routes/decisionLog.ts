// src/http/routes/decisionLog.ts
//
// Read-only HTTP surface over the `agent_decision_log` SQL view (defined in
// db/schema.ts). The view denormalizes the last 24h of recommendations with
// their latest approval / execution / outcome rows joined in, so the UI can
// render a single feed without N+1 lookups.
//
// We pass the result through as a column->value object so the client can
// evolve the schema without a hard TS contract here.

import { Hono } from 'hono'
import type { Env } from '@/index'

export const decisionLogRouter = new Hono<{ Bindings: Env }>()

// GET /api/decision-log?account_id=...&limit=200
decisionLogRouter.get('/', async (c) => {
  const accountId = c.req.query('account_id')
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 200

  const sql = accountId
    ? `SELECT * FROM agent_decision_log WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM agent_decision_log ORDER BY created_at DESC LIMIT ?`
  const params = accountId ? [accountId, limit] : [limit]

  const { columns, rows } = await c.env.DB.query(sql, params)
  const out = rows.map((r) =>
    Object.fromEntries(columns.map((col, i) => [col, r[i] ?? null])),
  )
  return c.json(out)
})
