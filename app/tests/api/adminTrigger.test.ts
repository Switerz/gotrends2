// tests/api/adminTrigger.test.ts
//
// HTTP tests for /api/admin/trigger/* routes. These are manual on-demand
// equivalents of /cron/* — same logic, but guarded by `requireIngestToken`
// (header `X-Ingest-Token`) instead of the gateway-only X-Godeploy-Cron
// header. We verify (a) auth fail-closed, (b) shape parity with cron, and
// (c) that the same exported business logic runs for the happy path.

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'

interface Write {
  sql: string
  params: unknown[]
}

interface RecordingDB extends GodeployDB {
  writes: Write[]
}

function makeEnv(overrides: Partial<Env> = {}): { env: Env; db: RecordingDB } {
  const writes: Write[] = []
  const db: RecordingDB = {
    writes,
    async exec(sql, params = []) {
      writes.push({ sql, params })
      return { rowsWritten: 1 }
    },
    async query() {
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
  return {
    env: { DB: db, INGEST_TOKEN: 'test-ingest-token', ...overrides } as Env,
    db,
  }
}

const post = (env: Env, headers: Record<string, string>, path: string) =>
  worker.fetch(
    new Request(`http://x${path}`, { method: 'POST', headers }),
    env,
    {} as ExecutionContext,
  )

describe('admin-trigger auth (requireIngestToken)', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 401 without the X-Ingest-Token header', async () => {
    const { env } = makeEnv()
    const res = await post(env, {}, '/api/admin/trigger/run-models')
    expect(res.status).toBe(401)
  })

  it('returns 401 when the X-Ingest-Token header is wrong', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-ingest-token': 'nope' },
      '/api/admin/trigger/run-models',
    )
    expect(res.status).toBe(401)
  })

  it('returns 500 server_misconfigured when INGEST_TOKEN env is missing', async () => {
    // Build env explicitly without INGEST_TOKEN.
    const db: GodeployDB = {
      async exec() {
        return { rowsWritten: 0 }
      },
      async query() {
        return { columns: [], rows: [], rowsRead: 0 }
      },
    }
    const env = { DB: db } as Env
    const res = await post(
      env,
      { 'x-ingest-token': 'whatever' },
      '/api/admin/trigger/run-models',
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('server_misconfigured')
  })
})

describe('POST /api/admin/trigger/run-models', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('runs the same logic as /cron/run-models — skipped when Metabase / Google Ads env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-ingest-token': 'test-ingest-token' },
      '/api/admin/trigger/run-models',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      skipped: boolean
      reason: string
      missing: { metabase: boolean; googleAds: boolean }
    }
    expect(body.skipped).toBe(true)
    expect(body.reason).toBe('env_missing')
    expect(body.missing.metabase).toBe(true)
    expect(body.missing.googleAds).toBe(true)
  })
})

describe('POST /api/admin/trigger/send-to-chat', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('runs the same logic as /cron/send-to-chat — skipped when GOOGLE_CHAT_WEBHOOK_URL is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-ingest-token': 'test-ingest-token' },
      '/api/admin/trigger/send-to-chat',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: boolean; reason: string }
    expect(body.skipped).toBe(true)
    expect(body.reason).toBe('no_webhook')
  })
})

describe('POST /api/admin/trigger/outcomes/24h', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('runs the same logic as /cron/outcomes/24h — metabase_unavailable when METABASE env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-ingest-token': 'test-ingest-token' },
      '/api/admin/trigger/outcomes/24h',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      computed: number
      skipped: number
      errors: string[]
    }
    expect(body.computed).toBe(0)
    expect(body.skipped).toBe(0)
    expect(body.errors).toEqual(['metabase_unavailable'])
  })
})

describe('POST /api/admin/trigger/outcomes/72h', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('runs the same logic as /cron/outcomes/72h — metabase_unavailable when METABASE env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-ingest-token': 'test-ingest-token' },
      '/api/admin/trigger/outcomes/72h',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      computed: number
      skipped: number
      errors: string[]
    }
    expect(body.computed).toBe(0)
    expect(body.skipped).toBe(0)
    expect(body.errors).toEqual(['metabase_unavailable'])
  })
})
