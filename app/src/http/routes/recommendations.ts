// src/http/routes/recommendations.ts
//
// Read-only HTTP surface for the `recommendations` table.
//
//   GET /api/recommendations            list (filterable by ?status=)
//   GET /api/recommendations/:id        detail
//
// account_label is denormalized in via AccountsRepo so the React client can
// render rows without an extra round trip.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { AccountsRepo } from '@/db/repos/accounts'
import { toRecommendationDTO } from '@/http/dto/recommendation'
import type { RecommendationStatus } from '@/core/types'
import { requireSession } from '@/http/middleware'

export const recsRouter = new Hono<{ Bindings: Env }>()
recsRouter.use('*', requireSession)

// GET /api/recommendations?status=pending&limit=100
recsRouter.get('/', async (c) => {
  const repo = new RecommendationsRepo(c.env.DB)
  const accountsRepo = new AccountsRepo(c.env.DB)
  const status = c.req.query('status') as RecommendationStatus | undefined
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100

  const rows = status
    ? await repo.listByStatus(status, limit)
    : await repo.listRecent(limit)

  // Denormalize account_label in a single pass over the distinct account ids.
  const accountIds = [...new Set(rows.map((r) => r.account_id))]
  const labelMap = new Map<string, string | null>()
  for (const id of accountIds) {
    const acc = await accountsRepo.get(id)
    labelMap.set(id, acc?.account_label ?? null)
  }
  return c.json(rows.map((r) => toRecommendationDTO(r, labelMap.get(r.account_id))))
})

// GET /api/recommendations/:id
recsRouter.get('/:id', async (c) => {
  const repo = new RecommendationsRepo(c.env.DB)
  const accountsRepo = new AccountsRepo(c.env.DB)
  const row = await repo.getById(c.req.param('id'))
  if (!row) return c.json({ error: 'not_found' }, 404)
  const acc = await accountsRepo.get(row.account_id)
  return c.json(toRecommendationDTO(row, acc?.account_label ?? null))
})
