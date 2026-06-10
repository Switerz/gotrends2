// tests/api/health.test.ts
//
// Smoke tests for the Worker entry point:
//  - /api/health returns { ok: true } and 200
//  - the first request runs the schema/seed bootstrap (many `exec` calls)
//  - the second request does NOT re-bootstrap (idempotency via module flag)
//
// Uses a minimal map-backed fake DB that only records calls; we do not
// actually execute SQL here (real DDL/seeding is covered in db/bootstrap.test).

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'

function makeFakeEnv(): Env {
  const tables = new Map<string, unknown[]>()
  return {
    DB: {
      async exec(sql: string) {
        const m = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i)
        if (m && !tables.has(m[1]!)) tables.set(m[1]!, [])
        return { rowsWritten: 1 }
      },
      async query() {
        return { columns: [], rows: [], rowsRead: 0 }
      },
    },
  } as unknown as Env
}

describe('GET /api/health', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns { ok: true } after bootstrap', async () => {
    const env = makeFakeEnv()
    const res = await worker.fetch(new Request('http://x/api/health'), env, {} as ExecutionContext)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('bootstraps the schema on first request', async () => {
    const env = makeFakeEnv()
    let execCount = 0
    const origExec = env.DB.exec.bind(env.DB)
    env.DB.exec = async (sql: string, params?: unknown[]) => {
      execCount++
      return origExec(sql, params)
    }
    await worker.fetch(new Request('http://x/api/health'), env, {} as ExecutionContext)
    // Many CREATE TABLEs + INSERTs — we just check it ran a non-trivial number.
    expect(execCount).toBeGreaterThan(10)
  })

  it('does not re-bootstrap on subsequent requests', async () => {
    const env = makeFakeEnv()
    await worker.fetch(new Request('http://x/api/health'), env, {} as ExecutionContext)
    let secondExec = 0
    const origExec = env.DB.exec.bind(env.DB)
    env.DB.exec = async (sql: string, params?: unknown[]) => {
      secondExec++
      return origExec(sql, params)
    }
    await worker.fetch(new Request('http://x/api/health'), env, {} as ExecutionContext)
    expect(secondExec).toBe(0)
  })
})
