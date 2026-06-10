// src/http/index.ts
//
// Mounts every feature router on the root app. Each area lives in its own
// file under `routes/` and is mounted at a stable URL prefix so the worker
// entry point (`src/index.ts`) only needs to call `mountApi(app)`.
//
// Subsequent phases will add more routers here (recommendations, runs,
// ingest, chat webhook, execute, cron) — Task 5.1b only wires up health.

import type { Hono } from 'hono'
import type { Env } from '@/index'
import { healthRouter } from './routes/health'

export function mountApi<T extends Hono<{ Bindings: Env }>>(app: T): T {
  app.route('/api', healthRouter)
  // Phase 5.2 will add: recommendations, runs, skills, ingest, decision-log
  // Phase 5.3 will add: chat webhook
  // Phase 5.4 will add: execute, cron
  return app
}
