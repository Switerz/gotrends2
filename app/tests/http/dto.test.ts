// tests/http/dto.test.ts
//
// Per-DTO mapping tests. We assert:
//  - every row column lands at its DTO counterpart
//  - nullable columns survive as nulls (no silent default coercion)
//  - the `accountLabel` extra arg flows into `account.label`

import { describe, it, expect } from 'vitest'
import { toRecommendationDTO } from '@/http/dto/recommendation'
import { toRunDTO } from '@/http/dto/run'
import { toApprovalDTO } from '@/http/dto/approval'
import type { ApprovalRow, ModelRunRow, RecommendationRow } from '@/db/types'

describe('toRecommendationDTO', () => {
  const row: RecommendationRow = {
    recommendation_id: 'rec-1',
    run_id: 'run-1',
    account_id: 'acc-1',
    campaign_id: 'camp-1',
    campaign_name: 'Campaign One',
    skill_type: 'budget_increase',
    recommended_action: 'increase_budget',
    change_percent: 10,
    current_budget_brl: 100,
    proposed_budget_brl: 110,
    current_target_roas: 3,
    proposed_target_roas: 3,
    expected_incremental_cost_brl: 10,
    expected_incremental_revenue_brl: 35,
    expected_marginal_roas: 3.5,
    projected_cos: 0.28,
    confidence_score: 0.82,
    risk_level: 'low',
    reason: 'reason text',
    guardrail_status: 'ok',
    guardrail_reason: null,
    llm_payload: '{"k":"v"}',
    llm_explanation: 'because trends',
    budget_resource_name: null,
    status: 'pending',
    expires_at: '2026-06-12T00:00:00Z',
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:01:00Z',
  }

  it('maps every field with an explicit account label', () => {
    const dto = toRecommendationDTO(row, 'Apice Label')
    expect(dto).toEqual({
      id: 'rec-1',
      runId: 'run-1',
      account: { id: 'acc-1', label: 'Apice Label' },
      campaign: { id: 'camp-1', name: 'Campaign One' },
      skill: 'budget_increase',
      action: 'increase_budget',
      changePercent: 10,
      current: { budgetBrl: 100, targetRoas: 3 },
      proposed: { budgetBrl: 110, targetRoas: 3 },
      expected: {
        incrementalCostBrl: 10,
        incrementalRevenueBrl: 35,
        marginalRoas: 3.5,
        projectedCos: 0.28,
      },
      confidence: 0.82,
      risk: 'low',
      guardrail: { status: 'ok', reason: null },
      reason: 'reason text',
      llmExplanation: 'because trends',
      status: 'pending',
      expiresAt: '2026-06-12T00:00:00Z',
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-10T00:01:00Z',
    })
  })

  it('defaults account.label to null when not provided', () => {
    const dto = toRecommendationDTO(row)
    expect(dto.account.label).toBeNull()
  })

  it('preserves nulls from the row (no coercion)', () => {
    const allNullRow: RecommendationRow = {
      ...row,
      change_percent: null,
      current_budget_brl: null,
      proposed_budget_brl: null,
      current_target_roas: null,
      proposed_target_roas: null,
      expected_incremental_cost_brl: null,
      expected_incremental_revenue_brl: null,
      expected_marginal_roas: null,
      projected_cos: null,
      confidence_score: null,
      risk_level: null,
      reason: null,
      guardrail_reason: null,
      llm_payload: null,
      llm_explanation: null,
      expires_at: null,
    }
    const dto = toRecommendationDTO(allNullRow, null)
    expect(dto.changePercent).toBeNull()
    expect(dto.current.budgetBrl).toBeNull()
    expect(dto.current.targetRoas).toBeNull()
    expect(dto.proposed.budgetBrl).toBeNull()
    expect(dto.proposed.targetRoas).toBeNull()
    expect(dto.expected.incrementalCostBrl).toBeNull()
    expect(dto.expected.incrementalRevenueBrl).toBeNull()
    expect(dto.expected.marginalRoas).toBeNull()
    expect(dto.expected.projectedCos).toBeNull()
    expect(dto.confidence).toBeNull()
    expect(dto.risk).toBeNull()
    expect(dto.guardrail.reason).toBeNull()
    expect(dto.reason).toBeNull()
    expect(dto.llmExplanation).toBeNull()
    expect(dto.expiresAt).toBeNull()
  })
})

describe('toRunDTO', () => {
  it('maps every field', () => {
    const row: ModelRunRow = {
      run_id: 'run-1',
      account_id: 'acc-1',
      run_ts: '2026-06-10T00:00:00Z',
      pipeline_version: '2.0.0',
      status: 'success',
      n_campaigns_scanned: 12,
      n_recommendations: 3,
      input_window_start: '2026-05-13',
      input_window_end: '2026-06-09',
      notes: 'ok',
    }
    expect(toRunDTO(row)).toEqual({
      id: 'run-1',
      accountId: 'acc-1',
      runTs: '2026-06-10T00:00:00Z',
      pipelineVersion: '2.0.0',
      status: 'success',
      nCampaignsScanned: 12,
      nRecommendations: 3,
      inputWindow: { start: '2026-05-13', end: '2026-06-09' },
      notes: 'ok',
    })
  })

  it('preserves nulls', () => {
    const row: ModelRunRow = {
      run_id: 'run-1',
      account_id: 'acc-1',
      run_ts: '2026-06-10T00:00:00Z',
      pipeline_version: '2.0.0',
      status: 'running',
      n_campaigns_scanned: null,
      n_recommendations: null,
      input_window_start: null,
      input_window_end: null,
      notes: null,
    }
    const dto = toRunDTO(row)
    expect(dto.nCampaignsScanned).toBeNull()
    expect(dto.nRecommendations).toBeNull()
    expect(dto.inputWindow).toEqual({ start: null, end: null })
    expect(dto.notes).toBeNull()
  })
})

describe('toApprovalDTO', () => {
  it('maps every field', () => {
    const row: ApprovalRow = {
      approval_id: 'app-1',
      recommendation_id: 'rec-1',
      account_id: 'acc-1',
      decision: 'approved',
      decided_by: 'alice@example.com',
      decided_via: 'chat',
      decided_at: '2026-06-10T01:00:00Z',
      note: 'looks good',
    }
    expect(toApprovalDTO(row)).toEqual({
      id: 'app-1',
      recommendationId: 'rec-1',
      accountId: 'acc-1',
      decision: 'approved',
      decidedBy: 'alice@example.com',
      decidedVia: 'chat',
      decidedAt: '2026-06-10T01:00:00Z',
      note: 'looks good',
    })
  })

  it('preserves nulls', () => {
    const row: ApprovalRow = {
      approval_id: 'app-1',
      recommendation_id: 'rec-1',
      account_id: 'acc-1',
      decision: 'rejected',
      decided_by: null,
      decided_via: null,
      decided_at: '2026-06-10T01:00:00Z',
      note: null,
    }
    const dto = toApprovalDTO(row)
    expect(dto.decidedBy).toBeNull()
    expect(dto.decidedVia).toBeNull()
    expect(dto.note).toBeNull()
  })
})
