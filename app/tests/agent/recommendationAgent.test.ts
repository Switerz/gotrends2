// tests/agent/recommendationAgent.test.ts
//
// Task 2.11 — verify the TS port of `recommendation_agent` matches the Python
// behaviour exactly (PT-BR strings, accent-less, brl currency, comma decimal).

import { describe, it, expect } from 'vitest'
import {
  ACTION_LABELS,
  buildLlmPayload,
  explainRecommendation,
  explanationAsDict,
  _fmt_currency,
  _fmt_number,
  _fmt_pct,
  type RecommendationInput,
} from '@/agent/recommendationAgent'

function basePayload(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    campaign_id: '123',
    campaign_name: 'Search NB',
    recommended_action: 'increase_budget',
    change_percent: 0.12,
    expected_incremental_cost: 620,
    expected_incremental_revenue: 1850,
    expected_marginal_roas: 2.98,
    projected_cos: 0.143,
    confidence_score: 78,
    risk_level: 'medium',
    business_constraints_status: 'ok',
    constraints_reason: null,
    approval_status: 'approved',
    reason: 'constraint=budget_limited; saturation=moderate; confidence=78',
    ...overrides,
  }
}

describe('recommendationAgent — branching', () => {
  it('blocked → headline contains "bloqueada" and doNotExecuteReason is set', () => {
    const exp = explainRecommendation(
      basePayload({
        business_constraints_status: 'blocked',
        constraints_reason: 'manual_learning_test_active',
      }),
    )
    expect(exp.headline).toContain('bloqueada')
    expect(exp.headline).toBe('Acao bloqueada para Search NB')
    expect(exp.doNotExecuteReason).toBe('manual_learning_test_active')
    expect(exp.explanation).toContain('manual_learning_test_active')
    expect(exp.explanation).toContain('aumentar budget')
  })

  it('needs_human_review → headline starts with "Candidata:" and approvalNote says human approval pending', () => {
    const exp = explainRecommendation(
      basePayload({
        business_constraints_status: 'needs_human_review',
        constraints_reason: 'manual_learning_test',
        approval_status: 'approved', // even with approved, review status forces the pending note
      }),
    )
    expect(exp.headline.startsWith('Candidata:')).toBe(true)
    expect(exp.headline).toBe('Candidata: aumentar budget em Search NB')
    expect(exp.approvalNote).toBe('Aprovacao humana pendente antes de qualquer execucao.')
    expect(exp.doNotExecuteReason).toBeNull()
  })

  it('approval_status pending + status ok → approvalNote says human approval pending', () => {
    const exp = explainRecommendation(
      basePayload({
        business_constraints_status: 'ok',
        approval_status: 'pending',
      }),
    )
    expect(exp.approvalNote).toBe('Aprovacao humana pendente antes de qualquer execucao.')
    expect(exp.doNotExecuteReason).toBeNull()
  })

  it('approval_status approved → approvalNote mentions approved status', () => {
    const exp = explainRecommendation(
      basePayload({
        business_constraints_status: 'ok',
        approval_status: 'approved',
      }),
    )
    expect(exp.approvalNote).toBe('Status de aprovacao: approved.')
  })
})

describe('recommendationAgent — null handling', () => {
  it('all null numeric fields → formatters return "indisponivel"', () => {
    const exp = explainRecommendation(
      basePayload({
        change_percent: null,
        expected_incremental_cost: null,
        expected_incremental_revenue: null,
        expected_marginal_roas: null,
        projected_cos: null,
        confidence_score: null,
        risk_level: null,
        constraints_reason: null,
        reason: null,
      }),
    )
    expect(exp.expectedImpact).toBe(
      'Impacto esperado: custo incremental indisponivel, receita incremental indisponivel, ROAS marginal indisponivel e COS projetado indisponivel.',
    )
    expect(exp.riskAndConfidence).toBe(
      'Risco: indisponivel. Confianca estatistica: indisponivel.',
    )
    expect(exp.constraintsChecked).toBe('Status dos guardrails: ok. Razao: indisponivel.')
    expect(exp.explanation).toContain('A mudanca sugerida e indisponivel.')
    expect(exp.explanation).toContain('Motivo estruturado: indisponivel.')
  })
})

describe('recommendationAgent — formatters', () => {
  it('_fmt_currency: 1234.56 → "R$ 1.234,56", 0.5 → "R$ 0,50", null → "indisponivel"', () => {
    expect(_fmt_currency(1234.56)).toBe('R$ 1.234,56')
    expect(_fmt_currency(0.5)).toBe('R$ 0,50')
    expect(_fmt_currency(null)).toBe('indisponivel')
    expect(_fmt_currency(1234567.89)).toBe('R$ 1.234.567,89')
  })

  it('_fmt_pct: 0.123 → "12,3%", -0.05 → "-5,0%", null → "indisponivel"', () => {
    expect(_fmt_pct(0.123)).toBe('12,3%')
    expect(_fmt_pct(-0.05)).toBe('-5,0%')
    expect(_fmt_pct(null)).toBe('indisponivel')
  })

  it('_fmt_number: 2.98 → "2,98", null → "indisponivel"', () => {
    expect(_fmt_number(2.98)).toBe('2,98')
    expect(_fmt_number(null)).toBe('indisponivel')
    expect(_fmt_number(0)).toBe('0,00')
  })
})

describe('recommendationAgent — action labels', () => {
  it('all 6 keys map to PT-BR strings', () => {
    expect(ACTION_LABELS.increase_budget).toBe('aumentar budget')
    expect(ACTION_LABELS.increase_troas_or_reduce_budget).toBe('aumentar tROAS ou reduzir budget')
    expect(ACTION_LABELS.optimize_efficiency).toBe('otimizar eficiencia')
    expect(ACTION_LABELS.improve_ads_or_terms).toBe('melhorar anuncios ou termos')
    expect(ACTION_LABELS.review_landing_or_offer).toBe('revisar landing page ou oferta')
    expect(ACTION_LABELS.monitor).toBe('monitorar')
    expect(Object.keys(ACTION_LABELS)).toHaveLength(6)
  })

  it('unknown action falls back to the action key itself (matching Python .get default)', () => {
    const exp = explainRecommendation(
      basePayload({ recommended_action: 'mystery_action' }),
    )
    expect(exp.headline).toBe('Candidata: mystery_action em Search NB')
  })
})

describe('recommendationAgent — buildLlmPayload', () => {
  it('missing campaign_id → throws and message mentions the field', () => {
    expect(() =>
      buildLlmPayload({
        campaign_name: 'Search NB',
        recommended_action: 'increase_budget',
        business_constraints_status: 'ok',
        approval_status: 'approved',
      }),
    ).toThrow(/campaign_id/)
  })

  it('missing multiple required fields → sorted list in error message', () => {
    expect(() =>
      buildLlmPayload({
        campaign_name: 'Search NB',
        recommended_action: 'increase_budget',
      }),
    ).toThrow(/approval_status, business_constraints_status, campaign_id/)
  })

  it('valid row → returns input with optional fields defaulting to null', () => {
    const payload = buildLlmPayload({
      campaign_id: '123',
      campaign_name: 'Search NB',
      recommended_action: 'increase_budget',
      business_constraints_status: 'ok',
      approval_status: 'approved',
    })
    expect(payload.campaign_id).toBe('123')
    expect(payload.change_percent).toBeNull()
    expect(payload.confidence_score).toBeNull()
    expect(payload.reason).toBeNull()
  })
})

describe('recommendationAgent — expectedImpact composition', () => {
  it('expectedImpact contains all 4 formatted numeric placeholders', () => {
    const exp = explainRecommendation(basePayload())
    expect(exp.expectedImpact).toBe(
      'Impacto esperado: custo incremental R$ 620,00, receita incremental R$ 1.850,00, ROAS marginal 2,98 e COS projetado 14,3%.',
    )
  })

  it('riskAndConfidence carries numeric confidence_score verbatim', () => {
    const exp = explainRecommendation(basePayload({ confidence_score: 78, risk_level: 'medium' }))
    expect(exp.riskAndConfidence).toBe('Risco: medium. Confianca estatistica: 78.')
  })
})

describe('recommendationAgent — explanationAsDict', () => {
  it('serializes all 7 camelCase fields', () => {
    const exp = explainRecommendation(basePayload())
    const dict = explanationAsDict(exp)
    expect(Object.keys(dict).sort()).toEqual(
      [
        'approvalNote',
        'constraintsChecked',
        'doNotExecuteReason',
        'expectedImpact',
        'explanation',
        'headline',
        'riskAndConfidence',
      ].sort(),
    )
    expect(dict.doNotExecuteReason).toBeNull()
    expect(dict.headline).toBe('Candidata: aumentar budget em Search NB')
  })
})
