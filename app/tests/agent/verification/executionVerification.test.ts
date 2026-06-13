// tests/agent/verification/executionVerification.test.ts
//
// Pure classifier tests for the post-execute verification logic. A fake
// GoogleAdsClient returns hand-crafted GAQL responses; we assert the
// classifier picks the right verdict per action × delta band.

import { describe, it, expect, vi } from 'vitest'
import { GoogleAdsClient } from '@/clients/googleAds'
import { verifyExecution } from '@/agent/verification/executionVerification'
import type { ExecutionRow, RecommendationRow } from '@/db/types'

const LOGIN_CUSTOMER_ID = '1234567890'

function makeAdsClient(searchStreamImpl: (gaql: string) => Promise<unknown[]>): GoogleAdsClient {
  // We don't need full client surface — vi.fn on the one method we call.
  return {
    searchStream: vi.fn(searchStreamImpl),
  } as unknown as GoogleAdsClient
}

function baseRec(over: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    recommendation_id: 'rec-1',
    run_id: 'run-1',
    account_id: '7705857660',
    campaign_id: '99999',
    campaign_name: 'NB',
    skill_type: 'budget_reallocation',
    recommended_action: 'increase_troas_or_reduce_budget',
    change_percent: 0.1,
    current_budget_brl: 100,
    proposed_budget_brl: 110,
    current_target_roas: 5.0,
    proposed_target_roas: 5.5,
    expected_incremental_cost_brl: 10,
    expected_incremental_revenue_brl: 50,
    expected_marginal_roas: 5,
    projected_cos: 0.2,
    confidence_score: 80,
    risk_level: 'low',
    reason: null,
    guardrail_status: 'ok',
    guardrail_reason: null,
    llm_payload: null,
    llm_explanation: null,
    budget_resource_name: 'customers/7705857660/campaignBudgets/55555',
    bidding_learning_status: 'stable',
    observed_roas_7d: null,
    status: 'executed',
    expires_at: null,
    created_at: '2026-06-12T00:00:00Z',
    updated_at: '2026-06-12T00:00:00Z',
    ...over,
  }
}

function baseExec(): ExecutionRow {
  return {
    execution_id: 'exec-1',
    recommendation_id: 'rec-1',
    account_id: '7705857660',
    attempt_number: 1,
    status: 'success',
    google_ads_request: null,
    google_ads_response: null,
    error_message: null,
    created_at: '2026-06-12T00:00:00Z',
    completed_at: '2026-06-12T00:01:00Z',
    verified_at: null,
    verification_status: null,
    verified_value: null,
  }
}

describe('verifyExecution — tROAS path', () => {
  it('observed equals proposed → match (1 % tolerance)', async () => {
    const ads = makeAdsClient(async () => [
      {
        campaign: { id: '99999', maximizeConversionValue: { targetRoas: 5.5 } },
      },
    ])
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('match')
    expect(r.observedValue).toBe(5.5)
  })

  it('observed within 1 % of proposed → match (rounding tolerance)', async () => {
    const ads = makeAdsClient(async () => [
      { campaign: { maximizeConversionValue: { targetRoas: 5.503 } } }, // 0.05 %
    ])
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('match')
  })

  it('observed within 1-10 % of proposed → drifted', async () => {
    const ads = makeAdsClient(async () => [
      { campaign: { maximizeConversionValue: { targetRoas: 5.8 } } }, // 5.45 %
    ])
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('drifted')
  })

  it('observed > 10 % off from proposed → reverted (manual rollback signal)', async () => {
    const ads = makeAdsClient(async () => [
      { campaign: { maximizeConversionValue: { targetRoas: 4.0 } } }, // 27 %
    ])
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('reverted')
    expect(r.observedValue).toBe(4.0)
    expect(r.proposedValue).toBe(5.5)
  })

  it('campaign missing from response → unavailable', async () => {
    const ads = makeAdsClient(async () => [])
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('unavailable')
    expect(r.observedValue).toBeNull()
  })

  it('targetRoas field missing → unavailable (proposed still surfaced)', async () => {
    const ads = makeAdsClient(async () => [
      { campaign: { id: '99999' } }, // no maximizeConversionValue
    ])
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('unavailable')
    expect(r.observedValue).toBeNull()
    expect(r.proposedValue).toBe(5.5)
  })

  it('GAQL throws → unavailable (no propagated exception)', async () => {
    const ads = makeAdsClient(async () => {
      throw new Error('googleAds 500: boom')
    })
    const r = await verifyExecution(ads, LOGIN_CUSTOMER_ID, baseExec(), baseRec())
    expect(r.status).toBe('unavailable')
  })

  it('proposed_target_roas is null → unavailable (cannot compute delta)', async () => {
    const ads = makeAdsClient(async () => [
      { campaign: { maximizeConversionValue: { targetRoas: 5.5 } } },
    ])
    const r = await verifyExecution(
      ads,
      LOGIN_CUSTOMER_ID,
      baseExec(),
      baseRec({ proposed_target_roas: null }),
    )
    expect(r.status).toBe('unavailable')
    // We DO surface the observed value — useful diagnostic.
    expect(r.observedValue).toBe(5.5)
  })
})

describe('verifyExecution — budget path', () => {
  it('budget mutate: micros / 1_000_000 vs proposed_budget_brl', async () => {
    const ads = makeAdsClient(async () => [
      { campaignBudget: { amountMicros: '110000000' } }, // R$ 110
    ])
    const r = await verifyExecution(
      ads,
      LOGIN_CUSTOMER_ID,
      baseExec(),
      baseRec({ recommended_action: 'increase_budget' }),
    )
    expect(r.status).toBe('match')
    expect(r.observedValue).toBe(110)
  })

  it('reduce_budget action also takes the budget path', async () => {
    const ads = makeAdsClient(async () => [
      { campaignBudget: { amountMicros: '50000000' } }, // R$ 50 (way off proposed R$ 110)
    ])
    const r = await verifyExecution(
      ads,
      LOGIN_CUSTOMER_ID,
      baseExec(),
      baseRec({ recommended_action: 'reduce_budget' }),
    )
    expect(r.status).toBe('reverted')
  })
})

describe('verifyExecution — non-executable actions', () => {
  it('e.g. monitor → unavailable (should never reach the executor in the first place)', async () => {
    const ads = makeAdsClient(async () => [{ campaign: {} }])
    const r = await verifyExecution(
      ads,
      LOGIN_CUSTOMER_ID,
      baseExec(),
      baseRec({ recommended_action: 'monitor' }),
    )
    expect(r.status).toBe('unavailable')
  })
})
