// tests/db/repos/executions.test.ts

import { describe, it, expect } from 'vitest'
import { ExecutionsRepo } from '@/db/repos/executions'
import type { ExecutionRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function baseExec(over: Partial<ExecutionRow> = {}): Omit<ExecutionRow, 'created_at'> {
  return {
    execution_id: 'ex-1',
    recommendation_id: 'rec-1',
    account_id: '7705857660',
    attempt_number: 1,
    status: 'pending',
    google_ads_request: null,
    google_ads_response: null,
    error_message: null,
    completed_at: null,
    verified_at: null,
    verification_status: null,
    verified_value: null,
    ...over,
  } as Omit<ExecutionRow, 'created_at'>
}

describe('ExecutionsRepo', () => {
  it('insert + getById round-trip', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    await repo.insert(baseExec({ execution_id: 'e-1', google_ads_request: '{"foo":1}' }))
    const got = await repo.getById('e-1')
    expect(got?.execution_id).toBe('e-1')
    expect(got?.google_ads_request).toBe('{"foo":1}')
    expect(got?.status).toBe('pending')
  })

  it('getById returns null when missing', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    expect(await repo.getById('nope')).toBeNull()
  })

  it('setStatus updates status, completed_at, and error_message', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    await repo.insert(baseExec({ execution_id: 'e-x' }))
    await repo.setStatus('e-x', 'success', '2026-06-10 12:00:00')
    const got = await repo.getById('e-x')
    expect(got?.status).toBe('success')
    expect(got?.completed_at).toBe('2026-06-10 12:00:00')
    expect(got?.error_message).toBeNull()
  })

  it('setStatus combines errorCode and errorMessage', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    await repo.insert(baseExec({ execution_id: 'e-fail' }))
    await repo.setStatus('e-fail', 'failed', '2026-06-10 12:00:00', 'QUOTA_EXCEEDED', 'rate limit')
    const got = await repo.getById('e-fail')
    expect(got?.status).toBe('failed')
    expect(got?.error_message).toBe('[QUOTA_EXCEEDED] rate limit')
  })

  it('listByRecommendation only returns matching recommendation', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    await repo.insert(baseExec({ execution_id: 'e-1', recommendation_id: 'r1', attempt_number: 1 }))
    await repo.insert(baseExec({ execution_id: 'e-2', recommendation_id: 'r2', attempt_number: 1 }))
    await repo.insert(baseExec({ execution_id: 'e-3', recommendation_id: 'r1', attempt_number: 2 }))
    const got = await repo.listByRecommendation('r1')
    expect(got.map((e) => e.execution_id)).toEqual(['e-1', 'e-3'])
  })

  it('listByStatus filters and returns []', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    await repo.insert(baseExec({ execution_id: 'e-1', status: 'pending' }))
    await repo.insert(baseExec({ execution_id: 'e-2', status: 'success' }))
    await repo.insert(baseExec({ execution_id: 'e-3', status: 'failed' }))
    expect((await repo.listByStatus('success')).map((e) => e.execution_id)).toEqual(['e-2'])
    expect(await repo.listByStatus('cancelled')).toEqual([])
  })

  it('preserves null fields on read', async () => {
    const db = makeFakeDb()
    const repo = new ExecutionsRepo(db)
    await repo.insert(
      baseExec({
        execution_id: 'e-null',
        google_ads_request: null,
        google_ads_response: null,
        error_message: null,
        completed_at: null,
      }),
    )
    const got = await repo.getById('e-null')
    expect(got?.google_ads_request).toBeNull()
    expect(got?.google_ads_response).toBeNull()
    expect(got?.error_message).toBeNull()
    expect(got?.completed_at).toBeNull()
  })

  describe('findUnverifiedInBand + markVerified', () => {
    it('returns only successful, unverified rows whose completed_at is inside the band', async () => {
      const db = makeFakeDb()
      const repo = new ExecutionsRepo(db)
      // Eligible: success + completed in band + unverified
      await repo.insert(
        baseExec({
          execution_id: 'eligible',
          status: 'success',
          completed_at: '2026-06-12T10:00:00Z',
        }),
      )
      // Excluded: failed status
      await repo.insert(
        baseExec({
          execution_id: 'failed',
          status: 'failed',
          completed_at: '2026-06-12T10:00:00Z',
        }),
      )
      // Excluded: completed_at outside band (too old)
      await repo.insert(
        baseExec({
          execution_id: 'old',
          status: 'success',
          completed_at: '2026-06-10T00:00:00Z',
        }),
      )
      // Excluded: already verified. `insert` doesn't carry verification
      // columns (those belong to markVerified), so we stamp them separately.
      await repo.insert(
        baseExec({
          execution_id: 'done',
          status: 'success',
          completed_at: '2026-06-12T11:00:00Z',
        }),
      )
      await repo.markVerified('done', '2026-06-12T13:00:00Z', 'match', 5.5)
      const got = await repo.findUnverifiedInBand(
        '2026-06-12T08:00:00Z',
        '2026-06-12T12:00:00Z',
      )
      expect(got.map((e) => e.execution_id)).toEqual(['eligible'])
    })

    it('orders by completed_at ASC so older rows are processed first', async () => {
      const db = makeFakeDb()
      const repo = new ExecutionsRepo(db)
      await repo.insert(
        baseExec({
          execution_id: 'newer',
          status: 'success',
          completed_at: '2026-06-12T11:00:00Z',
        }),
      )
      await repo.insert(
        baseExec({
          execution_id: 'older',
          status: 'success',
          completed_at: '2026-06-12T09:00:00Z',
        }),
      )
      const got = await repo.findUnverifiedInBand(
        '2026-06-12T00:00:00Z',
        '2026-06-12T23:59:59Z',
      )
      expect(got.map((e) => e.execution_id)).toEqual(['older', 'newer'])
    })

    it('markVerified stamps verified_at / status / value', async () => {
      const db = makeFakeDb()
      const repo = new ExecutionsRepo(db)
      await repo.insert(
        baseExec({
          execution_id: 'e-stamp',
          status: 'success',
          completed_at: '2026-06-12T10:00:00Z',
        }),
      )
      await repo.markVerified('e-stamp', '2026-06-12T13:00:00Z', 'reverted', 4.2)
      const got = await repo.getById('e-stamp')
      expect(got?.verified_at).toBe('2026-06-12T13:00:00Z')
      expect(got?.verification_status).toBe('reverted')
      expect(got?.verified_value).toBe(4.2)
    })

    it('a verified row no longer shows up in findUnverifiedInBand', async () => {
      const db = makeFakeDb()
      const repo = new ExecutionsRepo(db)
      await repo.insert(
        baseExec({
          execution_id: 'e-cycle',
          status: 'success',
          completed_at: '2026-06-12T10:00:00Z',
        }),
      )
      const before = await repo.findUnverifiedInBand(
        '2026-06-12T00:00:00Z',
        '2026-06-12T23:00:00Z',
      )
      expect(before.map((e) => e.execution_id)).toContain('e-cycle')
      await repo.markVerified('e-cycle', '2026-06-12T13:00:00Z', 'match', 5.5)
      const after = await repo.findUnverifiedInBand(
        '2026-06-12T00:00:00Z',
        '2026-06-12T23:00:00Z',
      )
      expect(after.map((e) => e.execution_id)).not.toContain('e-cycle')
    })
  })
})
