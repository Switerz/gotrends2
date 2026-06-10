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
