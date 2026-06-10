// tests/agent/tools/persistDecision.test.ts
//
// Wire test: persistDecision must funnel everything through refine() and then
// hand off to RecommendationsRepo.insert(). A "blocked" candidate still inserts
// (guardrail_status='blocked'), it just never reaches the chat step downstream.

import { describe, it, expect } from 'vitest'
import { persistDecision } from '@/agent/tools/persistDecision'
import { CandidateInvalid } from '@/core/errors'
import type { GodeployDB } from '@/db/bootstrap'

interface RecordedExec {
  sql: string
  params: unknown[]
}

interface FakeDb extends GodeployDB {
  execs: RecordedExec[]
}

function fakeDb(): FakeDb {
  const execs: RecordedExec[] = []
  return {
    execs,
    async exec(sql: string, params: unknown[] = []) {
      execs.push({ sql, params })
      return { rowsWritten: 1 }
    },
    async query() {
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
}

const ctx = {
  runId: '00000000-0000-4000-8000-000000000001',
  recommendationId: '00000000-0000-4000-8000-000000000002',
}

const baseCandidate = {
  account_id: '7705857660',
  campaign_id: 'c-001',
  campaign_name: 'Search NB',
  skill_type: 'budget_reallocation',
  recommended_action: 'increase_budget' as const,
  change_percent: 0.10,
  current_budget_brl: 1000,
  current_target_roas: null,
  expected_marginal_roas: 3,
  confidence_score: 80,
  risk_level: 'medium' as const,
  reason: 'test',
}

describe('persistDecision', () => {
  it('happy path: inserts one row into recommendations with guardrail_status=ok', async () => {
    const db = fakeDb()
    await persistDecision(db, baseCandidate, ctx)

    const inserts = db.execs.filter((e) =>
      /INSERT INTO recommendations\b/.test(e.sql),
    )
    expect(inserts.length).toBe(1)

    // Spot-check the parameter order matches the repo's INSERT statement.
    const params = inserts[0]!.params
    expect(params[0]).toBe(ctx.recommendationId) // recommendation_id
    expect(params[1]).toBe(ctx.runId) // run_id
    expect(params[2]).toBe('7705857660') // account_id
    expect(params[3]).toBe('c-001') // campaign_id
    expect(params[6]).toBe('increase_budget') // recommended_action
    expect(params[9]).toBe(1100) // proposed_budget_brl
    expect(params[19]).toBe('ok') // guardrail_status
    expect(params[20]).toBeNull() // guardrail_reason
    expect(params[23]).toBe('pending') // status
  })

  it('blocked path: still inserts the row, but with guardrail_status=blocked', async () => {
    const db = fakeDb()
    await persistDecision(db, { ...baseCandidate, change_percent: 0.80 }, ctx)

    const inserts = db.execs.filter((e) =>
      /INSERT INTO recommendations\b/.test(e.sql),
    )
    expect(inserts.length).toBe(1)
    const params = inserts[0]!.params
    expect(params[19]).toBe('blocked')
    expect(params[20]).toBe('change_above_50pct_hard_limit')
  })

  it('throws CandidateInvalid and never touches the DB on bad input', async () => {
    const db = fakeDb()
    await expect(
      persistDecision(
        db,
        { ...baseCandidate, recommended_action: 'lol' } as unknown,
        ctx,
      ),
    ).rejects.toThrow(CandidateInvalid)
    expect(db.execs.length).toBe(0)
  })
})
