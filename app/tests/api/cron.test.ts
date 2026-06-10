// tests/api/cron.test.ts
//
// HTTP tests for /cron/* routes. Verifies the `X-Godeploy-Cron` guard, the
// graceful "skipped" responses when env vars are unset, and the outcomes
// stubs.

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
    env: { DB: db, GODEPLOY_CRON_KEY: 'cron-secret', ...overrides } as Env,
    db,
  }
}

const post = (env: Env, headers: Record<string, string>, path: string) =>
  worker.fetch(
    new Request(`http://x${path}`, { method: 'POST', headers }),
    env,
    {} as ExecutionContext,
  )

describe('cron auth (requireCronKey)', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 403 without the X-Godeploy-Cron header', async () => {
    const { env } = makeEnv()
    const res = await post(env, {}, '/cron/run-models')
    expect(res.status).toBe(403)
  })

  it('returns 403 when the X-Godeploy-Cron header is wrong', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'nope' },
      '/cron/run-models',
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /cron/run-models', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 + skipped when Metabase / Google Ads env is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/run-models',
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

describe('POST /cron/send-to-chat', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 + skipped when GOOGLE_CHAT_WEBHOOK_URL is missing', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/send-to-chat',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skipped: boolean; reason: string }
    expect(body.skipped).toBe(true)
    expect(body.reason).toBe('no_webhook')
  })
})

describe('POST /cron/outcomes/24h', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 with the stub payload + errors array', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/outcomes/24h',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      computed: number
      skipped: number
      errors: string[]
    }
    expect(body.computed).toBe(0)
    expect(body.skipped).toBe(0)
    expect(Array.isArray(body.errors)).toBe(true)
    expect(body.errors.length).toBeGreaterThan(0)
  })
})

describe('POST /cron/outcomes/72h', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 200 with the stub payload + errors array', async () => {
    const { env } = makeEnv()
    const res = await post(
      env,
      { 'x-godeploy-cron': 'cron-secret' },
      '/cron/outcomes/72h',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      computed: number
      skipped: number
      errors: string[]
    }
    expect(body.computed).toBe(0)
    expect(body.skipped).toBe(0)
    expect(Array.isArray(body.errors)).toBe(true)
    expect(body.errors.length).toBeGreaterThan(0)
  })
})
