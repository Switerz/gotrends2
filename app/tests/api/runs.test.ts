// tests/api/runs.test.ts
//
// HTTP tests for /api/runs. Mirrors the lightweight fake-DB pattern used by
// the recommendations route tests.

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'

interface Row {
  [k: string]: unknown
}

function makeEnv(runs: Row[]): Env {
  const db: GodeployDB = {
    async exec() {
      return { rowsWritten: 0 }
    },
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim()
      // getById
      let m = norm.match(/SELECT \* FROM model_runs WHERE run_id = \? LIMIT 1/i)
      if (m) {
        const id = params[0]
        const row = runs.find((r) => r['run_id'] === id)
        return materialize(row ? [row] : [])
      }
      // listByAccount
      m = norm.match(/SELECT \* FROM model_runs WHERE account_id = \? ORDER BY run_ts DESC LIMIT \?/i)
      if (m) {
        const acc = params[0]
        const lim = Number(params[1])
        return materialize(runs.filter((r) => r['account_id'] === acc).slice(0, lim))
      }
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
  return { DB: db } as Env
}

function materialize(rows: Row[]) {
  const colSet = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) colSet.add(k)
  const columns = Array.from(colSet)
  const tuples = rows.map((r) => columns.map((c) => r[c] ?? null))
  return { columns, rows: tuples, rowsRead: tuples.length }
}

function makeRun(over: Partial<Row> = {}): Row {
  return {
    run_id: 'run-1',
    account_id: 'acc-1',
    run_ts: '2026-01-01 00:00:00',
    pipeline_version: '0.1.0',
    status: 'success',
    n_campaigns_scanned: 5,
    n_recommendations: 3,
    input_window_start: '2025-12-25',
    input_window_end: '2026-01-01',
    notes: null,
    ...over,
  }
}

const fetchJson = async (env: Env, url: string) => {
  const res = await worker.fetch(new Request(`http://x${url}`), env, {} as ExecutionContext)
  return { status: res.status, body: (await res.json()) as unknown }
}

describe('GET /api/runs', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 400 when account_id is missing', async () => {
    const env = makeEnv([])
    const { status, body } = await fetchJson(env, '/api/runs')
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'account_id is required' })
  })

  it('lists runs by account_id', async () => {
    const env = makeEnv([
      makeRun({ run_id: 'run-a', account_id: 'acc-1' }),
      makeRun({ run_id: 'run-b', account_id: 'acc-2' }),
    ])
    const { status, body } = await fetchJson(env, '/api/runs?account_id=acc-1')
    expect(status).toBe(200)
    const list = body as Array<{ id: string }>
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('run-a')
  })

  it('returns the detail row by id', async () => {
    const env = makeEnv([makeRun({ run_id: 'run-detail' })])
    const { status, body } = await fetchJson(env, '/api/runs/run-detail')
    expect(status).toBe(200)
    const dto = body as { id: string; inputWindow: { start: string | null; end: string | null } }
    expect(dto.id).toBe('run-detail')
    expect(dto.inputWindow.end).toBe('2026-01-01')
  })

  it('returns 404 when the run id is unknown', async () => {
    const env = makeEnv([])
    const { status, body } = await fetchJson(env, '/api/runs/missing')
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'not_found' })
  })
})
