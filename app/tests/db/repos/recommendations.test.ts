// tests/db/repos/recommendations.test.ts

import { describe, it, expect } from 'vitest'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import type { RecommendationRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function baseRec(
  over: Partial<RecommendationRow> = {},
): Omit<RecommendationRow, 'created_at' | 'updated_at'> {
  return {
    recommendation_id: 'rec-1',
    run_id: 'run-1',
    account_id: '7705857660',
    campaign_id: 'camp-1',
    campaign_name: 'Campaign One',
    skill_type: 'budget_reallocation',
    recommended_action: 'increase_budget',
    change_percent: 0.1,
    current_budget_brl: 100,
    proposed_budget_brl: 110,
    current_target_roas: null,
    proposed_target_roas: null,
    expected_incremental_cost_brl: 10,
    expected_incremental_revenue_brl: 30,
    expected_marginal_roas: 3,
    projected_cos: 0.2,
    confidence_score: 80,
    risk_level: 'medium',
    reason: 'roas trending up',
    guardrail_status: 'ok',
    guardrail_reason: null,
    llm_payload: null,
    llm_explanation: null,
    status: 'pending',
    expires_at: null,
    ...over,
  } as Omit<RecommendationRow, 'created_at' | 'updated_at'>
}

describe('RecommendationsRepo', () => {
  it('insert + getById round-trip preserves all fields', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    await repo.insert(baseRec({ recommendation_id: 'rec-A', confidence_score: 90 }))
    const got = await repo.getById('rec-A')
    expect(got?.recommendation_id).toBe('rec-A')
    expect(got?.confidence_score).toBe(90)
    expect(got?.skill_type).toBe('budget_reallocation')
    expect(got?.status).toBe('pending')
    expect(got?.guardrail_status).toBe('ok')
  })

  it('getById returns null when missing; listByStatus returns []', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    expect(await repo.getById('nope')).toBeNull()
    expect(await repo.listByStatus('approved')).toEqual([])
  })

  it('setStatus mutates status and updates updated_at', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    await repo.insert(baseRec({ recommendation_id: 'rec-B' }))
    const before = await repo.getById('rec-B')
    const beforeUpdatedAt = before?.updated_at
    await new Promise((r) => setTimeout(r, 1100)) // ensure datetime('now') advances by >=1s
    await repo.setStatus('rec-B', 'approved')
    const after = await repo.getById('rec-B')
    expect(after?.status).toBe('approved')
    expect(after?.updated_at).not.toBe(beforeUpdatedAt)
    expect(typeof after?.updated_at).toBe('string')
  })

  it('listByStatus only returns matching status rows', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    await repo.insert(baseRec({ recommendation_id: 'r1', status: 'pending' }))
    await repo.insert(baseRec({ recommendation_id: 'r2', status: 'approved' }))
    await repo.insert(baseRec({ recommendation_id: 'r3', status: 'pending' }))
    const pending = await repo.listByStatus('pending')
    expect(pending.map((r) => r.recommendation_id).sort()).toEqual(['r1', 'r3'])
    const approved = await repo.listByStatus('approved')
    expect(approved.map((r) => r.recommendation_id)).toEqual(['r2'])
  })

  it('listByAccountCampaign filters on BOTH account_id and campaign_id', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    await repo.insert(baseRec({ recommendation_id: 'r-1', account_id: 'A', campaign_id: 'c1' }))
    await repo.insert(baseRec({ recommendation_id: 'r-2', account_id: 'A', campaign_id: 'c2' }))
    await repo.insert(baseRec({ recommendation_id: 'r-3', account_id: 'B', campaign_id: 'c1' }))
    await repo.insert(baseRec({ recommendation_id: 'r-4', account_id: 'A', campaign_id: 'c1' }))
    const got = await repo.listByAccountCampaign('A', 'c1')
    expect(got.map((r) => r.recommendation_id).sort()).toEqual(['r-1', 'r-4'])
  })

  it('preserves null in nullable columns (expected_marginal_roas, llm_payload)', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    await repo.insert(
      baseRec({
        recommendation_id: 'r-null',
        expected_marginal_roas: null,
        llm_payload: null,
        llm_explanation: null,
        risk_level: null,
      }),
    )
    const got = await repo.getById('r-null')
    expect(got?.expected_marginal_roas).toBeNull()
    expect(got?.llm_payload).toBeNull()
    expect(got?.llm_explanation).toBeNull()
    expect(got?.risk_level).toBeNull()
  })

  it('listRecent orders by created_at DESC', async () => {
    const db = makeFakeDb()
    const repo = new RecommendationsRepo(db)
    await repo.insert(baseRec({ recommendation_id: 'old' }))
    // Manually backdate created_at for the first row so the ordering is deterministic
    // without depending on the host clock's millisecond resolution.
    const arr = db.tables.get('recommendations')!
    arr[0]!.created_at = '2026-06-01 00:00:00'
    await repo.insert(baseRec({ recommendation_id: 'mid' }))
    arr[1]!.created_at = '2026-06-05 00:00:00'
    await repo.insert(baseRec({ recommendation_id: 'new' }))
    arr[2]!.created_at = '2026-06-09 00:00:00'
    const recent = await repo.listRecent()
    expect(recent.map((r) => r.recommendation_id)).toEqual(['new', 'mid', 'old'])
  })

  describe('findActiveByCampaign', () => {
    const NON_TERMINAL_STATUSES = [
      'pending',
      'sent_to_chat',
      'approved',
      'executing',
    ] as const
    const TERMINAL_STATUSES = [
      'executed',
      'failed',
      'rejected',
      'expired',
    ] as const

    it.each(NON_TERMINAL_STATUSES)(
      'returns the rec when its status is %s (in-flight, blocks new gen)',
      async (status) => {
        const db = makeFakeDb()
        const repo = new RecommendationsRepo(db)
        await repo.insert(
          baseRec({ recommendation_id: `rec-${status}`, status }),
        )
        const got = await repo.findActiveByCampaign('7705857660', 'camp-1')
        expect(got).not.toBeNull()
        expect(got?.recommendation_id).toBe(`rec-${status}`)
        expect(got?.status).toBe(status)
      },
    )

    it.each(TERMINAL_STATUSES)(
      'returns null when only %s recs exist (terminal, frees the campaign)',
      async (status) => {
        const db = makeFakeDb()
        const repo = new RecommendationsRepo(db)
        await repo.insert(
          baseRec({ recommendation_id: `rec-${status}`, status }),
        )
        const got = await repo.findActiveByCampaign('7705857660', 'camp-1')
        expect(got).toBeNull()
      },
    )

    it('returns null when no rec exists for the (account, campaign) pair', async () => {
      const db = makeFakeDb()
      const repo = new RecommendationsRepo(db)
      // Different account → not a match
      await repo.insert(
        baseRec({ recommendation_id: 'other', account_id: 'other-acc' }),
      )
      // Different campaign → not a match
      await repo.insert(
        baseRec({ recommendation_id: 'other-camp', campaign_id: 'camp-other' }),
      )
      expect(
        await repo.findActiveByCampaign('7705857660', 'camp-1'),
      ).toBeNull()
    })

    it('returns the most recent non-terminal rec when multiple exist (defensive)', async () => {
      // Schema does not enforce single-active invariant — the repo defends
      // against it by ordering DESC and taking the first row.
      const db = makeFakeDb()
      const repo = new RecommendationsRepo(db)
      await repo.insert(baseRec({ recommendation_id: 'older', status: 'pending' }))
      const arr = db.tables.get('recommendations')!
      arr[0]!.created_at = '2026-06-01 00:00:00'
      await repo.insert(baseRec({ recommendation_id: 'newer', status: 'sent_to_chat' }))
      arr[1]!.created_at = '2026-06-08 00:00:00'
      const got = await repo.findActiveByCampaign('7705857660', 'camp-1')
      expect(got?.recommendation_id).toBe('newer')
    })

    it('ignores terminal recs when a non-terminal one is also present', async () => {
      const db = makeFakeDb()
      const repo = new RecommendationsRepo(db)
      // A failed (terminal) rec from yesterday + a pending one from today —
      // dedup should hit the pending one.
      await repo.insert(baseRec({ recommendation_id: 'failed-old', status: 'failed' }))
      await repo.insert(baseRec({ recommendation_id: 'pending-now', status: 'pending' }))
      const got = await repo.findActiveByCampaign('7705857660', 'camp-1')
      expect(got?.recommendation_id).toBe('pending-now')
    })
  })
})
