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

// GET /api/admin/debug/executions/:recommendationId
//
// Returns every `executions` row for a given recommendation, including the
// raw google_ads_request/response payloads and error_message. Used to
// post-mortem failed mutates (status=502 from /api/execute/:id) without
// having to ssh into the worker.
adminDebugRouter.get('/executions/:recommendationId', async (c) => {
  const id = c.req.param('recommendationId')
  const { columns, rows } = await c.env.DB.query(
    `SELECT * FROM executions
     WHERE recommendation_id = ?
     ORDER BY attempt_number DESC`,
    [id],
  )
  const out = rows.map((r) => {
    if (Array.isArray(r)) {
      const obj: Record<string, unknown> = {}
      columns.forEach((col, i) => {
        obj[col] = (r as unknown[])[i]
      })
      return obj
    }
    return r as Record<string, unknown>
  })
  return c.json({ recommendationId: id, executions: out })
})

// GET /api/admin/debug/campaigns
//
// Returns DISTINCT (campaign_id, campaign_name) from recommendations so we
// can audit what the pipeline has been seeing without hitting Google Ads.
// Useful for matching exercises (e.g. cross-reference Yampi utm_campaign
// against actual campaign names).
adminDebugRouter.get('/campaigns', async (c) => {
  const { columns, rows } = await c.env.DB.query(
    `SELECT DISTINCT campaign_id, campaign_name FROM recommendations
     ORDER BY campaign_name`,
    [],
  )
  const out = rows.map((r) => {
    if (Array.isArray(r)) {
      const obj: Record<string, unknown> = {}
      columns.forEach((col, i) => {
        obj[col] = (r as unknown[])[i]
      })
      return obj
    }
    return r as Record<string, unknown>
  })
  return c.json({ count: out.length, campaigns: out })
})

// GET /api/admin/debug/revenue-cache
//
// Quick visibility into campaign_revenue_daily — total rows, distinct dates,
// per-day count for the last 60 days. Used to confirm a backfill landed.
adminDebugRouter.get('/revenue-cache', async (c) => {
  const accountId = c.req.query('accountId') ?? '7705857660'
  const total = await c.env.DB.query(
    `SELECT COUNT(*) AS n FROM campaign_revenue_daily WHERE account_id = ?`,
    [accountId],
  )
  const byDate = await c.env.DB.query(
    `SELECT date, COUNT(*) AS n, SUM(revenue_brl) AS total_brl
     FROM campaign_revenue_daily
     WHERE account_id = ?
     GROUP BY date
     ORDER BY date DESC`,
    [accountId],
  )
  const totalRow = total.rows[0] as unknown
  const totalN = Array.isArray(totalRow)
    ? Number((totalRow as unknown[])[0] ?? 0)
    : Number((totalRow as Record<string, unknown>)?.['n'] ?? 0)
  const dateIdx = byDate.columns.indexOf('date')
  const nIdx = byDate.columns.indexOf('n')
  const totalIdx = byDate.columns.indexOf('total_brl')
  const dates = byDate.rows.map((r) => {
    if (Array.isArray(r)) {
      const arr = r as unknown[]
      return {
        date: String(arr[dateIdx]),
        rows: Number(arr[nIdx]),
        totalBrl: Number(arr[totalIdx]),
      }
    }
    const obj = r as Record<string, unknown>
    return {
      date: String(obj['date']),
      rows: Number(obj['n']),
      totalBrl: Number(obj['total_brl']),
    }
  })
  return c.json({ accountId, totalRows: totalN, distinctDates: dates.length, dates })
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
