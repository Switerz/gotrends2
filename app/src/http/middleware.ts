// src/http/middleware.ts
//
// Shared Hono middleware used across the API surface.
//
// - `requireIngestToken` protects ingestion endpoints (the pipeline POSTs runs).
// - `requireCronKey`     protects cron endpoints (Godeploy stamps the header).
// - `accessLog`          emits a single JSON log line per request, no PII.
//
// All middleware fail closed: if the matching env var is unset the request
// is rejected with 500 `server_misconfigured`, so we never accept traffic
// against a missing secret in production.

import type { MiddlewareHandler } from 'hono'
import type { Env } from '@/index'
import { decodeSession, readCookie } from '@/auth/session'
import { verifyChatJwt } from '@/auth/googleJwt'

/**
 * Variables exposed by `requireSession` for downstream handlers. Routes that
 * mount the middleware can read `c.var.userEmail` and type-narrow it via this
 * map.
 */
export interface SessionVars {
  userEmail: string
}

const DEFAULT_APP_ORIGIN = 'https://gotrends-agent.devgogroup.com'

/** Require `X-Ingest-Token` header matching `env.INGEST_TOKEN`. */
export const requireIngestToken: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.INGEST_TOKEN
  if (!expected) {
    return c.json({ error: 'server_misconfigured', detail: 'INGEST_TOKEN not set' }, 500)
  }
  const got = c.req.header('x-ingest-token')
  if (got !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

/**
 * Require `X-Execute-Token` header matching `env.EXECUTE_TOKEN`. Protects the
 * /api/execute/:id endpoint, which performs live Google Ads mutates. Fails
 * closed when the env var is unset.
 */
export const requireExecuteToken: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.EXECUTE_TOKEN
  if (!expected) {
    return c.json({ error: 'server_misconfigured', detail: 'EXECUTE_TOKEN not set' }, 500)
  }
  const got = c.req.header('x-execute-token')
  if (got !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

/**
 * Require `X-Godeploy-Cron` header matching `env.GODEPLOY_CRON_KEY`. Godeploy
 * stamps this header on every cron-triggered POST, so we can verify the
 * request came from the platform scheduler and not an attacker.
 */
export const requireCronKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.GODEPLOY_CRON_KEY
  if (!expected) {
    return c.json({ error: 'server_misconfigured', detail: 'GODEPLOY_CRON_KEY not set' }, 500)
  }
  const got = c.req.header('x-godeploy-cron')
  if (!got || got !== expected) {
    return c.json({ error: 'forbidden' }, 403)
  }
  await next()
}

/**
 * Require a valid `gotrends_session` cookie signed with `SESSION_SECRET`.
 * Exposes the authenticated user's email at `c.var.userEmail` for downstream
 * handlers. Fails closed when `SESSION_SECRET` is unset.
 */
export const requireSession: MiddlewareHandler<{
  Bindings: Env
  Variables: SessionVars
}> = async (c, next) => {
  const secret = c.env.SESSION_SECRET
  if (!secret) {
    return c.json({ error: 'server_misconfigured', detail: 'SESSION_SECRET not set' }, 500)
  }
  const cookie = readCookie(c.req.header('cookie'))
  if (!cookie) return c.json({ error: 'unauthorized' }, 401)
  const session = await decodeSession(cookie, secret, Date.now())
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  c.set('userEmail', session.email)
  await next()
}

/**
 * Require a Google-signed RS256 bearer JWT on /chat/webhook. The audience
 * must match `<APP_ORIGIN>/chat/webhook`. JWKS is fetched + cached inside
 * `verifyChatJwt`. Any failure (missing header, malformed token, bad
 * issuer/audience, expired, signature mismatch) yields 401.
 */
export const requireChatJwt: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  console.log(JSON.stringify({
    event: 'chat_webhook_entry',
    method: c.req.method,
    path: c.req.path,
    headers: Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [
      k,
      k.toLowerCase() === 'authorization' ? `${v.slice(0, 16)}…(${v.length}ch)` : v.slice(0, 200),
    ])),
  }))

  // Temporary bypass for debugging — set CHAT_JWT_BYPASS=1 to skip JWT verification
  if (c.env.CHAT_JWT_BYPASS === '1') {
    console.log(JSON.stringify({ event: 'chat_webhook_jwt_bypassed' }))
    await next()
    return
  }

  const auth = c.req.header('authorization')
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    console.log(JSON.stringify({
      event: 'chat_webhook_reject',
      reason: 'missing_bearer',
      hasAuthHeader: !!auth,
      authPrefix: auth?.slice(0, 12) ?? null,
    }))
    return c.json({ error: 'unauthorized', detail: 'missing bearer' }, 401)
  }
  const jwt = auth.replace(/^Bearer\s+/i, '')
  const audience = `${c.env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN}/chat/webhook`
  try {
    await verifyChatJwt(jwt, audience, Date.now())
  } catch (e) {
    // Decode payload (no verification) to log iss/aud/exp for debug
    let payloadDebug: Record<string, unknown> = {}
    try {
      const parts = jwt.split('.')
      if (parts.length === 3 && parts[1]) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
        const decoded = JSON.parse(atob(padded)) as Record<string, unknown>
        payloadDebug = {
          iss: decoded.iss,
          aud: decoded.aud,
          exp: decoded.exp,
          azp: decoded.azp,
          email: decoded.email,
        }
      }
    } catch {
      payloadDebug = { decode_error: true }
    }
    console.log(JSON.stringify({
      event: 'chat_webhook_reject',
      reason: 'jwt_verify_failed',
      error: (e as Error).message,
      expectedAudience: audience,
      payload: payloadDebug,
    }))
    return c.json({ error: 'unauthorized', detail: (e as Error).message }, 401)
  }
  await next()
}

/** Lightweight access log; emits a single JSON line per request. No PII. */
export const accessLog: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const start = performance.now()
  await next()
  const elapsed = Math.round(performance.now() - start)
  console.log(
    JSON.stringify({
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: elapsed,
    }),
  )
}
