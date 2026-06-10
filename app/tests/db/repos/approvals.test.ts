// tests/db/repos/approvals.test.ts

import { describe, it, expect } from 'vitest'
import { ApprovalsRepo } from '@/db/repos/approvals'
import type { ApprovalRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function baseApproval(over: Partial<ApprovalRow> = {}): Omit<ApprovalRow, 'decided_at'> {
  return {
    approval_id: 'ap-1',
    recommendation_id: 'rec-1',
    account_id: '7705857660',
    decision: 'approved',
    decided_by: 'pedro@gobeaute.com.br',
    decided_via: 'google_chat',
    note: null,
    ...over,
  } as Omit<ApprovalRow, 'decided_at'>
}

describe('ApprovalsRepo', () => {
  it('insert + listByRecommendation round-trip', async () => {
    const db = makeFakeDb()
    const repo = new ApprovalsRepo(db)
    await repo.insert(baseApproval({ approval_id: 'a-1' }))
    const got = await repo.listByRecommendation('rec-1')
    expect(got.length).toBe(1)
    expect(got[0]!.approval_id).toBe('a-1')
    expect(got[0]!.decision).toBe('approved')
  })

  it('listByRecommendation returns [] when none exist', async () => {
    const db = makeFakeDb()
    const repo = new ApprovalsRepo(db)
    expect(await repo.listByRecommendation('rec-missing')).toEqual([])
  })

  it('listByRecommendation only returns matching recommendation rows', async () => {
    const db = makeFakeDb()
    const repo = new ApprovalsRepo(db)
    await repo.insert(baseApproval({ approval_id: 'a1', recommendation_id: 'r1' }))
    await repo.insert(baseApproval({ approval_id: 'a2', recommendation_id: 'r2' }))
    await repo.insert(baseApproval({ approval_id: 'a3', recommendation_id: 'r1' }))
    const r1Approvals = await repo.listByRecommendation('r1')
    expect(r1Approvals.map((a) => a.approval_id).sort()).toEqual(['a1', 'a3'])
  })

  it('orders results by decided_at DESC', async () => {
    const db = makeFakeDb()
    const repo = new ApprovalsRepo(db)
    await repo.insert(baseApproval({ approval_id: 'a1' }))
    await repo.insert(baseApproval({ approval_id: 'a2' }))
    await repo.insert(baseApproval({ approval_id: 'a3' }))
    const arr = db.tables.get('approvals')!
    arr[0]!.decided_at = '2026-06-01 00:00:00'
    arr[1]!.decided_at = '2026-06-09 00:00:00'
    arr[2]!.decided_at = '2026-06-05 00:00:00'
    const got = await repo.listByRecommendation('rec-1')
    expect(got.map((a) => a.approval_id)).toEqual(['a2', 'a3', 'a1'])
  })

  it('preserves null note', async () => {
    const db = makeFakeDb()
    const repo = new ApprovalsRepo(db)
    await repo.insert(baseApproval({ approval_id: 'a-null', note: null, decided_by: null }))
    const got = await repo.listByRecommendation('rec-1')
    expect(got[0]!.note).toBeNull()
    expect(got[0]!.decided_by).toBeNull()
  })
})
