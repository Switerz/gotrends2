// src/http/routes/runs.ts
//
// Read-only HTTP surface for the `model_runs` table.
//
//   GET /api/runs?account_id=...        list runs for an account (required)
//   GET /api/runs/:id                   detail

import { Hono } from 'hono'
import type { Env } from '@/index'
import { RunsRepo } from '@/db/repos/runs'
import { toRunDTO } from '@/http/dto/run'
import { requireSession } from '@/http/middleware'

export const runsRouter = new Hono<{ Bindings: Env }>()
runsRouter.use('*', requireSession)

// GET /api/runs?account_id=7705857660&limit=50
runsRouter.get('/', async (c) => {
  const repo = new RunsRepo(c.env.DB)
  const accountId = c.req.query('account_id')
  if (!accountId) return c.json({ error: 'account_id is required' }, 400)
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50
  const rows = await repo.listByAccount(accountId, limit)
  return c.json(rows.map(toRunDTO))
})

// GET /api/runs/:id
runsRouter.get('/:id', async (c) => {
  const repo = new RunsRepo(c.env.DB)
  const row = await repo.getById(c.req.param('id'))
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(toRunDTO(row))
})
