// src/index.ts
//
// Worker entry point. Builds a Hono app, ensures the SQLite schema is
// bootstrapped + seeded on the first request to this Worker instance, and
// delegates HTTP routing to `mountApi`.
//
// Bootstrap is idempotent (DDL uses `CREATE TABLE IF NOT EXISTS`, seeds use
// `INSERT OR IGNORE` / `INSERT OR REPLACE`), but we still gate it behind a
// module-level flag so we don't re-run dozens of statements on every request.

import { Hono } from 'hono'
import { bootstrapSchema, seedReferenceData, type GodeployDB } from './db/bootstrap'
import { mountApi } from './http'

export interface Env {
  DB: GodeployDB
  // External secrets — set via Godeploy `setAppSecret` in Phase 7.
  GOOGLE_ADS_DEVELOPER_TOKEN?: string
  GOOGLE_ADS_CLIENT_ID?: string
  GOOGLE_ADS_CLIENT_SECRET?: string
  GOOGLE_ADS_REFRESH_TOKEN?: string
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string
  METABASE_URL?: string
  METABASE_API_KEY?: string
  METABASE_DATABASE_ID?: string
  GOOGLE_CHAT_WEBHOOK_URL?: string
  GOOGLE_CHAT_VERIFICATION_TOKEN?: string
  INGEST_TOKEN?: string
  GODEPLOY_CRON_KEY?: string
}

let bootstrapped = false

async function ensureBootstrap(env: Env): Promise<void> {
  if (bootstrapped) return
  await bootstrapSchema(env.DB)
  await seedReferenceData(env.DB)
  bootstrapped = true
}

/**
 * TESTING ONLY: reset the bootstrap flag so each test starts from a clean
 * "first request" state. Not used outside of tests.
 */
export function _resetBootstrapForTests(): void {
  bootstrapped = false
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  await ensureBootstrap(c.env)
  await next()
})

mountApi(app)

export default { fetch: app.fetch }
