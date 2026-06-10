// tests/db/repos/runs.test.ts

import { describe, it, expect } from 'vitest'
import { RunsRepo } from '@/db/repos/runs'
import type { ModelRunRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function baseRun(over: Partial<ModelRunRow> = {}): Omit<ModelRunRow, 'run_ts'> {
  return {
    run_id: 'run-1',
    account_id: '7705857660',
    pipeline_version: 'v2.0.0',
    status: 'running',
    n_campaigns_scanned: null,
    n_recommendations: null,
    input_window_start: '2026-05-01',
    input_window_end: '2026-06-01',
    notes: null,
    ...over,
  } as Omit<ModelRunRow, 'run_ts'>
}

describe('RunsRepo', () => {
  it('insert + getById round-trip', async () => {
    const db = makeFakeDb()
    const repo = new RunsRepo(db)
    await repo.insert(baseRun({ run_id: 'r-1', pipeline_version: 'v2.0.1' }))
    const got = await repo.getById('r-1')
    expect(got?.run_id).toBe('r-1')
    expect(got?.pipeline_version).toBe('v2.0.1')
    expect(got?.status).toBe('running')
  })

  it('getById returns null when missing', async () => {
    const db = makeFakeDb()
    const repo = new RunsRepo(db)
    expect(await repo.getById('nope')).toBeNull()
  })

  it('updateStatus mutates status and counts', async () => {
    const db = makeFakeDb()
    const repo = new RunsRepo(db)
    await repo.insert(baseRun({ run_id: 'r-2' }))
    await repo.updateStatus('r-2', 'succeeded', 5, 3)
    const got = await repo.getById('r-2')
    expect(got?.status).toBe('succeeded')
    expect(got?.n_campaigns_scanned).toBe(5)
    expect(got?.n_recommendations).toBe(3)
  })

  it('updateStatus persists nulls when counts omitted', async () => {
    const db = makeFakeDb()
    const repo = new RunsRepo(db)
    await repo.insert(baseRun({ run_id: 'r-3' }))
    await repo.updateStatus('r-3', 'failed')
    const got = await repo.getById('r-3')
    expect(got?.status).toBe('failed')
    expect(got?.n_campaigns_scanned).toBeNull()
    expect(got?.n_recommendations).toBeNull()
  })

  it('listByAccount filters by account and returns []', async () => {
    const db = makeFakeDb()
    const repo = new RunsRepo(db)
    await repo.insert(baseRun({ run_id: 'r-a', account_id: 'A' }))
    await repo.insert(baseRun({ run_id: 'r-b', account_id: 'B' }))
    await repo.insert(baseRun({ run_id: 'r-c', account_id: 'A' }))
    const onlyA = await repo.listByAccount('A')
    expect(onlyA.map((r) => r.run_id).sort()).toEqual(['r-a', 'r-c'])
    expect(await repo.listByAccount('Z')).toEqual([])
  })

  it('preserves null notes on insert', async () => {
    const db = makeFakeDb()
    const repo = new RunsRepo(db)
    await repo.insert(baseRun({ run_id: 'r-n', notes: null }))
    const got = await repo.getById('r-n')
    expect(got?.notes).toBeNull()
  })
})
