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
  // The middleware does NOT validate the signature embedded in the
  // X-Godeploy-Cron header — the value is a signed payload whose exact
  // format is undocumented and unverifiable from our side. Presence of the
  // header (which only the Godeploy edge can stamp) is what we trust.
  // See middleware.ts docstring for the full rationale and threat model.

  it('returns 403 forbidden when X-Godeploy-Cron header is missing', async () => {
    const fetcher = mountWith(requireCronKey, {})
    const res = await fetcher(new Request('http://x/protected'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; detail?: string }
    expect(body.error).toBe('forbidden')
    expect(body.detail).toMatch(/missing X-Godeploy-Cron/i)
  })

  it('passes through with ANY non-empty X-Godeploy-Cron value', async () => {
    // The actual production value is `t=<unix_ts>;sig=<hex>`. We don't
    // parse or verify; presence is sufficient.
    const fetcher = mountWith(requireCronKey, {})
    const res = await fetcher(
      new Request('http://x/protected', {
        headers: { 'x-godeploy-cron': 't=1781276400;sig=deadbeef' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('accepts requests regardless of GODEPLOY_CRON_KEY env var state', async () => {
    // No env binding required — the middleware is presence-only.
    const fetcher = mountWith(requireCronKey, {})
    const res = await fetcher(
      new Request('http://x/protected', {
        headers: { 'x-godeploy-cron': 'anything' },
      }),
    )
    expect(res.status).toBe(200)
  })
})
