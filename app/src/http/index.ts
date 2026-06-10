// src/http/index.ts
//
// Mounts every feature router on the root app. Each area lives in its own
// file under `routes/` and is mounted at a stable URL prefix so the worker
// entry point (`src/index.ts`) only needs to call `mountApi(app)`.
//
// Subsequent phases will add more routers here:
//   - Phase 5.3: chat webhook
//   - Phase 5.4: execute, cron

import type { Hono } from 'hono'
import type { Env } from '@/index'
import { healthRouter } from './routes/health'
import { recsRouter } from './routes/recommendations'
import { runsRouter } from './routes/runs'
import { skillsRouter } from './routes/skills'
import { decisionLogRouter } from './routes/decisionLog'
import { ingestRouter } from './routes/ingest'

export function mountApi<T extends Hono<{ Bindings: Env }>>(app: T): T {
  app.route('/api', healthRouter)
  app.route('/api/recommendations', recsRouter)
  app.route('/api/runs', runsRouter)
  app.route('/api/skills', skillsRouter)
  app.route('/api/decision-log', decisionLogRouter)
  app.route('/api/ingest', ingestRouter)
  // Phase 5.3 will add: /chat/webhook
  // Phase 5.4 will add: /api/execute, /api/cron/*
  return app
}
