// tests/db/repos/outcomes.test.ts

import { describe, it, expect } from 'vitest'
import { OutcomesRepo } from '@/db/repos/outcomes'
import type { ExecutionOutcomeRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function baseOutcome(
  over: Partial<ExecutionOutcomeRow> = {},
): Omit<ExecutionOutcomeRow, 'observed_at'> {
  return {
    outcome_id: 'o-1',
    recommendation_id: 'rec-1',
    execution_id: 'ex-1',
    account_id: '7705857660',
    window: '24h',
    observed_cost_brl: 100,
    observed_revenue_brl: 300,
    observed_roas: 3,
    observed_conversions: 5,
    expected_vs_actual_cost_delta: 5,
    expected_vs_actual_revenue_delta: 20,
    notes: null,
    ...over,
  } as Omit<ExecutionOutcomeRow, 'observed_at'>
}

describe('OutcomesRepo', () => {
  it('insert + listByRecommendation round-trip', async () => {
    const db = makeFakeDb()
    const repo = new OutcomesRepo(db)
    await repo.insert(baseOutcome({ outcome_id: 'o-A', observed_roas: 3.14 }))
    const got = await repo.listByRecommendation('rec-1')
    expect(got.length).toBe(1)
    expect(got[0]!.outcome_id).toBe('o-A')
    expect(got[0]!.observed_roas).toBe(3.14)
    expect(got[0]!.window).toBe('24h')
  })

  it('listByRecommendation returns [] when none exist', async () => {
    const db = makeFakeDb()
    const repo = new OutcomesRepo(db)
    expect(await repo.listByRecommendation('missing')).toEqual([])
  })

  it('listByRecommendation filters by recommendation_id', async () => {
    const db = makeFakeDb()
    const repo = new OutcomesRepo(db)
    await repo.insert(baseOutcome({ outcome_id: 'o-1', recommendation_id: 'r1' }))
    await repo.insert(baseOutcome({ outcome_id: 'o-2', recommendation_id: 'r2' }))
    await repo.insert(baseOutcome({ outcome_id: 'o-3', recommendation_id: 'r1' }))
    const got = await repo.listByRecommendation('r1')
    expect(got.map((o) => o.outcome_id).sort()).toEqual(['o-1', 'o-3'])
  })

  it('persists multiple windows for one recommendation', async () => {
    const db = makeFakeDb()
    const repo = new OutcomesRepo(db)
    await repo.insert(baseOutcome({ outcome_id: 'o-24', window: '24h' }))
    await repo.insert(baseOutcome({ outcome_id: 'o-72', window: '72h' }))
    await repo.insert(baseOutcome({ outcome_id: 'o-7d', window: '7d' }))
    const got = await repo.listByRecommendation('rec-1')
    expect(got.map((o) => o.window).sort()).toEqual(['24h', '72h', '7d'])
  })

  it('preserves null notes and delta fields', async () => {
    const db = makeFakeDb()
    const repo = new OutcomesRepo(db)
    await repo.insert(
      baseOutcome({
        outcome_id: 'o-null',
        notes: null,
        expected_vs_actual_cost_delta: null,
        expected_vs_actual_revenue_delta: null,
        observed_conversions: null,
      }),
    )
    const got = await repo.listByRecommendation('rec-1')
    expect(got[0]!.notes).toBeNull()
    expect(got[0]!.expected_vs_actual_cost_delta).toBeNull()
    expect(got[0]!.expected_vs_actual_revenue_delta).toBeNull()
    expect(got[0]!.observed_conversions).toBeNull()
  })
})
