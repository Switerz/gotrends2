// tests/http/middleware.test.ts
//
// Unit tests for the auth middleware. We mount each middleware on a tiny
// Hono app with a no-op handler behind it, then drive requests through
// `app.fetch` to exercise the full status/JSON path.

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { requireIngestToken, requireCronKey } from '@/http/middleware'
import type { Env } from '@/index'

function mountWith(mw: typeof requireIngestToken, env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>()
  app.use('*', mw)
  app.get('/protected', (c) => c.json({ ok: true }))
  return (req: Request) => app.fetch(req, env as Env)
}

describe('requireIngestToken', () => {
  it('returns 500 server_misconfigured if INGEST_TOKEN env var is missing', async () => {
    const fetcher = mountWith(requireIngestToken, {})
    const res = await fetcher(new Request('http://x/protected'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'server_misconfigured',
      detail: 'INGEST_TOKEN not set',
    })
  })

  it('returns 401 unauthorized when header is missing', async () => {
    const fetcher = mountWith(requireIngestToken, { INGEST_TOKEN: 'secret' })
    const res = await fetcher(new Request('http://x/protected'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns 401 unauthorized when header is wrong', async () => {
    const fetcher = mountWith(requireIngestToken, { INGEST_TOKEN: 'secret' })
    const res = await fetcher(
      new Request('http://x/protected', { headers: { 'x-ingest-token': 'nope' } }),
    )
    expect(res.status).toBe(401)
  })

  it('passes through when header matches', async () => {
    const fetcher = mountWith(requireIngestToken, { INGEST_TOKEN: 'secret' })
    const res = await fetcher(
      new Request('http://x/protected', { headers: { 'x-ingest-token': 'secret' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('requireCronKey', () => {
  it('returns 500 server_misconfigured if GODEPLOY_CRON_KEY env var is missing', async () => {
    const fetcher = mountWith(requireCronKey, {})
    const res = await fetcher(new Request('http://x/protected'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'server_misconfigured',
      detail: 'GODEPLOY_CRON_KEY not set',
    })
  })

  it('returns 403 forbidden when header is missing', async () => {
    const fetcher = mountWith(requireCronKey, { GODEPLOY_CRON_KEY: 'cron-secret' })
    const res = await fetcher(new Request('http://x/protected'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  it('returns 403 forbidden when header is wrong', async () => {
    const fetcher = mountWith(requireCronKey, { GODEPLOY_CRON_KEY: 'cron-secret' })
    const res = await fetcher(
      new Request('http://x/protected', { headers: { 'x-godeploy-cron': 'nope' } }),
    )
    expect(res.status).toBe(403)
  })

  it('passes through when header matches', async () => {
    const fetcher = mountWith(requireCronKey, { GODEPLOY_CRON_KEY: 'cron-secret' })
    const res = await fetcher(
      new Request('http://x/protected', {
        headers: { 'x-godeploy-cron': 'cron-secret' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
