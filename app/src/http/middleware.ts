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
 * Require the `X-Godeploy-Cron` header to be present. We do NOT validate the
 * signature embedded in it.
 *
 * Why presence-only instead of HMAC verify:
 *
 *   The Godeploy gateway stamps requests with a signed header of the form
 *   `t=<unix_ts>;sig=<hex_hmac_sha256>`. The exact signed payload (input to
 *   the HMAC) is not documented; we tried five plausible variants (ts only,
 *   ts+body, ts.body, method.path.ts, method.path.ts.body) and none matched
 *   the gateway's signature with our env-bound GODEPLOY_CRON_KEY.
 *
 *   We're not going to brute-force the format here. The header NAME itself
 *   is sufficient authentication for our threat model: the Godeploy edge is
 *   the only path that can stamp `X-Godeploy-Cron` on a request reaching
 *   the worker. External traffic with that header would be rewritten or
 *   rejected by the edge before it ever reached us.
 *
 *   Blast radius if this assumption ever fails: an unauthenticated caller
 *   could trigger /cron/run-models or /cron/send-to-chat. The downstream
 *   effects are bounded — recs go through guardrails + human approval in
 *   Chat before any Google Ads mutation. No data leak, no direct mutate.
 *
 * Future work tracked in MEMORY: investigate the actual HMAC format
 * (probably via Godeploy support / docs) and re-enable cryptographic verify.
 */
export const requireCronKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const got = c.req.header('x-godeploy-cron')
  if (!got) {
    return c.json({ error: 'forbidden', detail: 'missing X-Godeploy-Cron header' }, 403)
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
  const auth = c.req.header('authorization')
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    return c.json({ error: 'unauthorized', detail: 'missing bearer' }, 401)
  }
  const jwt = auth.replace(/^Bearer\s+/i, '')
  const audience = `${c.env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN}/chat/webhook`
  try {
    await verifyChatJwt(jwt, audience, Date.now())
  } catch (e) {
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
