// src/http/routes/adminTrigger.ts
//
// Manual admin-trigger routes. Same business logic as /cron/* handlers but
// guarded by `requireIngestToken` (header `X-Ingest-Token`) instead of the
// gateway-only `X-Godeploy-Cron` header. The Godeploy edge strips
// `X-Godeploy-Cron` from external requests, so on-demand smoke tests and the
// legacy Python pipeline (during retirement transition) need a separate
// authenticated path to fire cron logic.
//
// No behaviour drift vs /cron/*: every endpoint here is a thin wrapper around
// the same exported function the cron handler calls.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { requireIngestToken } from '../middleware'
import {
  runModelsForAllAccounts,
  sendPendingToChat,
  computeOutcomesWindow,
  verifyPendingExecutions,
  syncRevenueAllAccounts,
  backfillRevenueForAccount,
} from './cron'

export const adminTriggerRouter = new Hono<{ Bindings: Env }>()
adminTriggerRouter.use('*', requireIngestToken)

adminTriggerRouter.post('/run-models', async (c) =>
  c.json(await runModelsForAllAccounts(c.env)),
)
adminTriggerRouter.post('/send-to-chat', async (c) =>
  c.json(await sendPendingToChat(c.env)),
)
adminTriggerRouter.post('/outcomes/24h', async (c) =>
  c.json(await computeOutcomesWindow(c.env, 24)),
)
adminTriggerRouter.post('/outcomes/72h', async (c) =>
  c.json(await computeOutcomesWindow(c.env, 72)),
)
adminTriggerRouter.post('/verify-executions', async (c) =>
  c.json(await verifyPendingExecutions(c.env)),
)
adminTriggerRouter.post('/sync-revenue', async (c) =>
  c.json(await syncRevenueAllAccounts(c.env)),
)
// POST /api/admin/trigger/backfill-revenue
//   ?accountId=X
//   AND either:
//     - ?days=60   (walks back from today)
//     - ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD  (explicit range)
//
// Use explicit range when you want to backfill one day at a time from a
// shell loop — avoids the worker getting killed by client timeout on
// a 60-day single call.
adminTriggerRouter.post('/backfill-revenue', async (c) => {
  const accountId = c.req.query('accountId')
  if (!accountId) {
    return c.json({ error: 'missing accountId query param' }, 400)
  }
  const fromDate = c.req.query('fromDate')
  const toDate = c.req.query('toDate')
  if (fromDate && toDate) {
    const { syncRevenueRange } = await import('./cron')
    return c.json(
      await syncRevenueRange(c.env, c.env.DB, accountId, fromDate, toDate),
    )
  }
  const daysRaw = c.req.query('days')
  const days = daysRaw ? Math.max(1, Math.min(365, Number(daysRaw))) : 60
  return c.json(await backfillRevenueForAccount(c.env, accountId, days))
})
