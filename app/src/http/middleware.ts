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
 * Require a Godeploy-stamped `X-Godeploy-Cron` header. Format:
 *
 *     t=<unix_timestamp>;sig=<hex_hmac_sha256>
 *
 * The gateway computes `sig = HMAC-SHA256(<message>, GODEPLOY_CRON_KEY)`
 * where `<message>` is one of a handful of documented combinations
 * (timestamp alone, timestamp + body, etc). We try the plausible variants
 * and accept the first that matches in constant time.
 *
 * Timestamps outside ±5 minutes of `now` are rejected as replay.
 */
export const requireCronKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.GODEPLOY_CRON_KEY
  if (!expected) {
    return c.json({ error: 'server_misconfigured', detail: 'GODEPLOY_CRON_KEY not set' }, 500)
  }
  const got = c.req.header('x-godeploy-cron')
  if (!got) return c.json({ error: 'forbidden' }, 403)

  const parsed = parseSignedCron(got)
  if (!parsed) return c.json({ error: 'forbidden', detail: 'bad header format' }, 403)

  const { tsSec, sig } = parsed
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - tsSec) > 300) {
    return c.json({ error: 'forbidden', detail: 'timestamp out of window' }, 403)
  }

  // Try the most-plausible signed payloads. Temporary diag tells us which one
  // hits; once known, we collapse to that single variant.
  const body = await c.req.text().catch(() => '')
  const candidates: Record<string, string> = {
    ts_only: String(tsSec),
    ts_dot_body: `${tsSec}.${body}`,
    ts_body: `${tsSec}${body}`,
    method_path_ts: `${c.req.method}.${c.req.path}.${tsSec}`,
    method_path_ts_body: `${c.req.method}.${c.req.path}.${tsSec}.${body}`,
  }
  const computed: Record<string, string> = {}
  for (const [k, msg] of Object.entries(candidates)) {
    computed[k] = await hmacSha256Hex(expected, msg)
  }
  const matchKey = Object.entries(computed).find(
    ([, hex]) => timingSafeEqHex(hex, sig),
  )?.[0]
  if (matchKey) {
    console.log(
      JSON.stringify({ event: 'cron_sig_match', path: c.req.path, variant: matchKey }),
    )
    await next()
    return
  }

  console.log(
    JSON.stringify({
      event: 'cron_sig_mismatch',
      path: c.req.path,
      tsSec,
      sig: sig.slice(0, 12),
      expectedKeyPrefix: expected.slice(0, 4),
      bodyLen: body.length,
      computedPrefixes: Object.fromEntries(
        Object.entries(computed).map(([k, h]) => [k, h.slice(0, 12)]),
      ),
    }),
  )
  return c.json({ error: 'forbidden' }, 403)
}

/** Parse `t=<digits>;sig=<hex>`. Returns null on any deviation. */
function parseSignedCron(raw: string): { tsSec: number; sig: string } | null {
  const m = raw.match(/^t=(\d+);sig=([0-9a-f]+)$/i)
  if (!m) return null
  const tsSec = Number(m[1])
  if (!Number.isFinite(tsSec) || tsSec <= 0) return null
  return { tsSec, sig: m[2]!.toLowerCase() }
}

/** Hex HMAC-SHA256 via Web Crypto (available in the Worker runtime). */
async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time equality on equal-length hex strings. */
function timingSafeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
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
