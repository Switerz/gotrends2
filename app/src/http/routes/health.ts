// src/http/routes/health.ts
//
// Trivial liveness endpoint. Used by:
//   - Godeploy health checks
//   - the smoke test in `tests/api/health.test.ts` which also verifies that
//     the auto-bootstrap middleware ran (a successful 200 implies schema +
//     seed completed without throwing).

import { Hono } from 'hono'
import type { Env } from '@/index'

export const healthRouter = new Hono<{ Bindings: Env }>()

healthRouter.get('/health', (c) => c.json({ ok: true }))
