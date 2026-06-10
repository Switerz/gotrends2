// dev/server.ts
//
// Node host that runs the same Hono Worker app used by Godeploy, but against a
// local SQLite database. Boots the schema, seeds dev data, and serves on
// http://localhost:8787. The Vite dev server (port 5173) proxies /api/* and
// /chat/* to this process.

import { serve } from '@hono/node-server'

import workerApp, { _resetBootstrapForTests, type Env } from '../src/index'
import { createLocalDb } from './db'
import { seedDevData } from './seed'

const PORT = Number(process.env.PORT ?? 8787)
const DB_PATH = process.env.DEV_DB_PATH ?? './dev.db'

async function main(): Promise<void> {
  const db = createLocalDb(DB_PATH)

  // Force the worker's module-level bootstrap flag back to false so the schema
  // gets created the first time we hit it below.
  _resetBootstrapForTests()

  const env: Env = {
    DB: db,
    GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    METABASE_URL: process.env.METABASE_URL,
    METABASE_API_KEY: process.env.METABASE_API_KEY,
    METABASE_DATABASE_ID: process.env.METABASE_DATABASE_ID,
    GOOGLE_CHAT_WEBHOOK_URL: process.env.GOOGLE_CHAT_WEBHOOK_URL,
    GOOGLE_CHAT_VERIFICATION_TOKEN: process.env.GOOGLE_CHAT_VERIFICATION_TOKEN,
    INGEST_TOKEN: process.env.INGEST_TOKEN ?? 'dev-ingest-token',
    GODEPLOY_CRON_KEY: process.env.GODEPLOY_CRON_KEY ?? 'dev-cron-key',
  }

  // Trigger the worker's bootstrap middleware via a single warm-up request so
  // the schema exists before we attempt to seed.
  await workerApp.fetch(
    new Request('http://localhost/api/health'),
    env,
    {} as ExecutionContext,
  )

  const seeded = await seedDevData(db)

  const dbLabel = DB_PATH === ':memory:' ? 'memory' : DB_PATH
  console.log(`[dev] DB initialized at ${dbLabel}`)
  if (seeded.recommendations === 0 && seeded.runs === 0) {
    console.log('[dev] Seed skipped (existing data found, idempotent)')
  } else {
    console.log(
      `[dev] Seeded: ${seeded.runs} runs, ${seeded.recommendations} recommendations, ${seeded.executions} executions, ${seeded.outcomes} outcomes`,
    )
  }

  serve({
    fetch: (req) => workerApp.fetch(req, env, {} as ExecutionContext),
    port: PORT,
  })

  console.log(`[dev] Listening on http://localhost:${PORT}`)
  console.log(`[dev] Health: http://localhost:${PORT}/api/health`)
  console.log(`[dev] Open the frontend on http://localhost:5173`)
}

main().catch((err) => {
  console.error('[dev] Failed to start:', err)
  process.exit(1)
})
