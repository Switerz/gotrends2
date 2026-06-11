// src/http/routes/auth.ts
//
// Browser-facing OAuth endpoints (mounted at /api/auth in src/http/index.ts —
// the /api/ prefix is required because the Godeploy asset handler swallows
// bare /auth/* paths and serves the SPA shell instead of the worker):
//   GET  /api/auth/login     → with Accept: application/json returns
//                              { url, state } JSON (sets CSRF state cookie);
//                              otherwise 302 to Google consent (legacy)
//   GET  /api/auth/callback  → exchanges code for identity, sets session
//                              cookie; with Accept: application/json returns
//                              { ok: true, email }, otherwise redirects to "/"
//   POST /api/auth/logout    → clears the session cookie
//   GET  /api/auth/me        → cheap "am I logged in?" check used by the SPA
//
// The JSON variants exist because Godeploy's SPA `not_found_handling` mode
// intercepts ALL Accept: text/html requests (including /api/auth/*) and serves
// the SPA shell. The SPA does the navigation itself: fetch JSON, then
// window.location to Google.
//
// Identity is gated by `ALLOWED_EMAIL_DOMAIN` (comma-separated list, default
// `gobeaute.com.br`) so even a successful Google login outside any of those
// domains is rejected with 403. Example: `gobeaute.com.br,gocase.com`.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { buildAuthorizeUrl, exchangeCode } from '@/auth/googleOauth'
import {
  encodeSession,
  buildSetCookieHeader,
  buildClearCookieHeader,
  readCookie,
  readNamedCookie,
  decodeSession,
} from '@/auth/session'

export const authRouter = new Hono<{ Bindings: Env }>()

const OAUTH_STATE_COOKIE = 'gotrends_oauth_state'
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000

function buildStateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
}

function clearStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

authRouter.get('/login', (c) => {
  const state = crypto.randomUUID()
  const url = buildAuthorizeUrl(c.env, state)
  c.header('Set-Cookie', buildStateCookie(state))

  const accept = c.req.header('accept') ?? ''
  if (accept.includes('application/json')) {
    return c.json({ url, state })
  }
  return c.redirect(url)
})

authRouter.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const expectedState = readNamedCookie(c.req.header('cookie'), OAUTH_STATE_COOKIE)

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: 'invalid_state' }, 400)
  }

  let user: { email: string; name: string }
  try {
    user = await exchangeCode(c.env, code)
  } catch (e) {
    return c.json({ error: 'oauth_exchange_failed', detail: (e as Error).message }, 502)
  }

  const allowedDomains = (c.env.ALLOWED_EMAIL_DOMAIN ?? 'gobeaute.com.br')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0)
  const userEmailLower = user.email.toLowerCase()
  const ok = allowedDomains.some((d) => userEmailLower.endsWith(`@${d}`))
  if (!ok) {
    // Clear the state cookie even on rejection so the next attempt starts clean.
    c.header('Set-Cookie', clearStateCookie())
    return c.json(
      {
        error: 'forbidden',
        detail: `email ${user.email} not in [${allowedDomains.map((d) => `@${d}`).join(', ')}]`,
      },
      403,
    )
  }

  const secret = c.env.SESSION_SECRET
  if (!secret) {
    return c.json({ error: 'server_misconfigured', detail: 'SESSION_SECRET not set' }, 500)
  }

  const session = await encodeSession(
    { email: user.email, expMs: Date.now() + SESSION_MAX_AGE_MS },
    secret,
  )

  c.header('Set-Cookie', buildSetCookieHeader(session))
  c.header('Set-Cookie', clearStateCookie(), { append: true })

  const accept = c.req.header('accept') ?? ''
  if (accept.includes('application/json')) {
    return c.json({ ok: true, email: user.email })
  }
  return c.redirect('/')
})

authRouter.post('/logout', (c) => {
  c.header('Set-Cookie', buildClearCookieHeader())
  return c.json({ ok: true })
})

authRouter.get('/me', async (c) => {
  const secret = c.env.SESSION_SECRET
  if (!secret) return c.json({ authenticated: false })
  const cookie = readCookie(c.req.header('cookie'))
  if (!cookie) return c.json({ authenticated: false })
  const s = await decodeSession(cookie, secret, Date.now())
  if (!s) return c.json({ authenticated: false })
  return c.json({ authenticated: true, email: s.email, expMs: s.expMs })
})
