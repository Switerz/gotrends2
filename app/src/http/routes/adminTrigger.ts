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
