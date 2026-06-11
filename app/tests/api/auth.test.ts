// tests/api/auth.test.ts
//
// Exercises the OAuth login / callback / logout / me endpoints via worker.fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import { TEST_SESSION_SECRET, makeSessionCookie } from '../auth/_helpers'

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {
      async exec() {
        return { rowsWritten: 0 }
      },
      async query() {
        return { columns: [], rows: [], rowsRead: 0 }
      },
    },
    SESSION_SECRET: TEST_SESSION_SECRET,
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    APP_ORIGIN: 'https://gotrends-agent.devgogroup.com',
    ALLOWED_EMAIL_DOMAIN: 'gobeaute.com.br',
    ...over,
  } as Env
}

describe('GET /api/auth/login', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('redirects to Google with a state cookie set (default Accept)', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/login'),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(loc).toMatch(/client_id=test-client-id/)
    expect(loc).toMatch(/redirect_uri=https%3A%2F%2Fgotrends-agent\.devgogroup\.com%2Fapi%2Fauth%2Fcallback/)
    expect(loc).toMatch(/scope=openid\+email\+profile/)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/gotrends_oauth_state=/)
    expect(cookie).toMatch(/HttpOnly/)
  })

  it('redirects to Google when Accept is text/html (legacy browser path)', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/login', { headers: { accept: 'text/html' } }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/accounts\.google\.com/)
  })

  it('returns JSON { url, state } when Accept: application/json (SPA path)', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/login', {
        headers: { accept: 'application/json' },
      }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; state: string }
    expect(body.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(body.url).toMatch(/client_id=test-client-id/)
    expect(body.state).toMatch(/^[0-9a-f-]{36}$/)
    // Cookie must still be set so the callback can validate the state.
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/gotrends_oauth_state=/)
    expect(cookie).toMatch(/HttpOnly/)
  })
})

describe('GET /api/auth/callback', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any
  beforeEach(() => _resetBootstrapForTests())
  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore()
  })

  it('rejects when state cookie is missing', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/callback?code=abc&state=xyz'),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_state' })
  })

  it('rejects when state does not match cookie', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/callback?code=abc&state=xyz', {
        headers: { cookie: 'gotrends_oauth_state=different' },
      }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(400)
  })

  it('exchanges code, sets session cookie, redirects to / (default Accept)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 })
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({ email: 'pedro@gobeaute.com.br', name: 'Pedro' }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await worker.fetch(
      new Request('http://x/api/auth/callback?code=abc&state=match', {
        headers: { cookie: 'gotrends_oauth_state=match' },
      }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    // Both the session and the state-cleanup cookie should be set.
    const cookies = res.headers.getSetCookie?.() ?? []
    const allCookies = cookies.length > 0 ? cookies.join('; ') : res.headers.get('set-cookie') ?? ''
    expect(allCookies).toMatch(/gotrends_session=/)
  })

  it('returns JSON { ok, email } when Accept: application/json (SPA path)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 })
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({ email: 'pedro@gobeaute.com.br', name: 'Pedro' }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await worker.fetch(
      new Request('http://x/api/auth/callback?code=abc&state=match', {
        headers: {
          cookie: 'gotrends_oauth_state=match',
          accept: 'application/json',
        },
      }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; email: string }
    expect(body.ok).toBe(true)
    expect(body.email).toBe('pedro@gobeaute.com.br')
    const cookies = res.headers.getSetCookie?.() ?? []
    const allCookies = cookies.length > 0 ? cookies.join('; ') : res.headers.get('set-cookie') ?? ''
    expect(allCookies).toMatch(/gotrends_session=/)
  })

  it('rejects emails outside the allowed domain', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 })
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
        return new Response(JSON.stringify({ email: 'pedro@evil.com', name: 'Pedro' }), {
          status: 200,
        })
      }
      throw new Error(`unexpected: ${url}`)
    })

    const res = await worker.fetch(
      new Request('http://x/api/auth/callback?code=abc&state=match', {
        headers: { cookie: 'gotrends_oauth_state=match' },
      }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('forbidden')
    expect(body.detail).toMatch(/gobeaute\.com\.br/)
  })

  it('returns 502 when Google token exchange fails', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response('boom', { status: 400 })
      }
      throw new Error(`unexpected: ${url}`)
    })

    const res = await worker.fetch(
      new Request('http://x/api/auth/callback?code=abc&state=match', {
        headers: { cookie: 'gotrends_oauth_state=match' },
      }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(502)
  })
})

describe('POST /api/auth/logout', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('clears the session cookie', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/logout', { method: 'POST' }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('set-cookie')).toMatch(/gotrends_session=;.*Max-Age=0/)
  })
})

describe('GET /api/auth/me', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns authenticated:false when no cookie is present', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/auth/me'),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: false })
  })

  it('returns authenticated:true with a valid cookie', async () => {
    const cookie = await makeSessionCookie('pedro@gobeaute.com.br')
    const res = await worker.fetch(
      new Request('http://x/api/auth/me', { headers: { cookie } }),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authenticated: boolean; email: string }
    expect(body.authenticated).toBe(true)
    expect(body.email).toBe('pedro@gobeaute.com.br')
  })

  it('returns authenticated:false when SESSION_SECRET is unset (server not configured yet)', async () => {
    const env = makeEnv({ SESSION_SECRET: undefined })
    const res = await worker.fetch(new Request('http://x/api/auth/me'), env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: false })
  })
})
