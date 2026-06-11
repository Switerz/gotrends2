// src/http/routes/adminDebug.ts
//
// Operator-only debug endpoints gated by the ingest token. These are used to
// diagnose runtime DB shape mismatches between local dev (better-sqlite3,
// arrays) and the live Godeploy Worker runtime (objects). Safe to keep in the
// codebase — the ingest token guard fails closed.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { requireIngestToken } from '../middleware'

export const adminDebugRouter = new Hono<{ Bindings: Env }>()
adminDebugRouter.use('*', requireIngestToken)

// GET /api/admin/debug/db-shape
//
// Returns the raw `{columns, rows, rowsRead}` from a SELECT against accounts,
// plus annotations that reveal whether the runtime hands us array-form or
// object-form rows. Hits both indexing strategies so we can confirm which one
// actually yields data on this runtime.
adminDebugRouter.get('/db-shape', async (c) => {
  const raw = await c.env.DB.query(
    `SELECT account_id, account_label, is_active FROM accounts LIMIT 3`,
    [],
  )
  const rowZero = raw.rows[0]
  const rowZeroType =
    rowZero !== undefined ? (Array.isArray(rowZero) ? 'array' : typeof rowZero) : 'no-row'
  const rowZeroAccountIdByName =
    rowZero && typeof rowZero === 'object' && !Array.isArray(rowZero)
      ? (rowZero as Record<string, unknown>)['account_id']
      : null
  const rowZeroAccountIdByIndex =
    rowZero && Array.isArray(rowZero) ? (rowZero as unknown[])[0] : null

  return c.json({
    columns: raw.columns,
    rows: raw.rows,
    rowsRead: raw.rowsRead,
    rowZeroType,
    rowZeroAccountIdByName,
    rowZeroAccountIdByIndex,
  })
})

// GET /api/admin/debug/counts
//
// Returns COUNT(*) for every well-known table so we can spot empty seed
// tables. Robust against both row shapes by checking `Array.isArray` first.
adminDebugRouter.get('/counts', async (c) => {
  const tables = [
    'accounts',
    'skills',
    'model_runs',
    'recommendations',
    'executions',
    'execution_outcomes',
    'chat_messages',
    'approvals',
    'campaign_settings_snapshot',
    'campaign_daily_features',
    'campaign_hourly_metrics',
  ]
  const out: Record<string, number | string> = {}
  for (const t of tables) {
    try {
      const { rows } = await c.env.DB.query(`SELECT COUNT(*) AS n FROM ${t}`, [])
      const r = rows[0]
      if (r === undefined) out[t] = -1
      else if (Array.isArray(r)) out[t] = Number((r as unknown[])[0]) || 0
      else out[t] = Number((r as Record<string, unknown>)['n']) || 0
    } catch (e) {
      out[t] = `error: ${(e as Error).message}`
    }
  }
  return c.json(out)
})
