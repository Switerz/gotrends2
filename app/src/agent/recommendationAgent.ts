// src/agent/recommendationAgent.ts
//
// LLM-facing recommendation explanation helpers for GoTrends v2.
//
// This module does NOT call an LLM. It validates the payload that an LLM may
// later explain, and provides a deterministic fallback explanation used as a
// baseline when the LLM is off.
//
// Ported 1:1 from `legacy/python/agent/recommendation_agent.py` (Task 2.11).
// Divergence vs. Python:
//   - Output field names use camelCase here (e.g. `expectedImpact`,
//     `doNotExecuteReason`) because this layer is LLM-facing and will be
//     serialized to JSON for a chat UI. Python uses snake_case
//     (`expected_impact`, `do_not_execute_reason`). `explanationAsDict`
//     emits the camelCase form on purpose — it is the contract.
//   - `buildLlmPayload` throws a plain `Error` (no ValueError equivalent in
//     TS), with a message mentioning the missing field(s).

export interface RecommendationInput {
  campaign_id: number | string
  campaign_name: string
  recommended_action: string
  change_percent: number | null
  expected_incremental_cost: number | null
  expected_incremental_revenue: number | null
  expected_marginal_roas: number | null
  projected_cos: number | null
  confidence_score: number | null
  risk_level: string | null
  business_constraints_status: string
  constraints_reason: string | null
  approval_status: string
  reason: string | null
}

export interface RecommendationExplanation {
  headline: string
  explanation: string
  expectedImpact: string
  riskAndConfidence: string
  constraintsChecked: string
  approvalNote: string
  doNotExecuteReason: string | null
}

export const ACTION_LABELS: Record<string, string> = {
  increase_budget: 'aumentar budget',
  increase_troas_or_reduce_budget: 'aumentar tROAS ou reduzir budget',
  optimize_efficiency: 'otimizar eficiencia',
  improve_ads_or_terms: 'melhorar anuncios ou termos',
  review_landing_or_offer: 'revisar landing page ou oferta',
  monitor: 'monitorar',
}

/**
 * Format a numeric value as Brazilian Real currency: "R$ 1.234,56".
 * Period as thousands separator, comma as decimal separator.
 * Null → "indisponivel".
 */
export function _fmt_currency(value: number | null): string {
  if (value === null || value === undefined) {
    return 'indisponivel'
  }
  // Mirror Python: f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const fixed = abs.toFixed(2) // "1234.56"
  const [intPart = '0', fracPart = '00'] = fixed.split('.')
  const intWithThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `R$ ${sign}${intWithThousands},${fracPart}`
}

/**
 * Format a fraction as percent with one decimal: 0.123 → "12,3%".
 * Null → "indisponivel".
 */
export function _fmt_pct(value: number | null): string {
  if (value === null || value === undefined) {
    return 'indisponivel'
  }
  // Mirror Python: f"{value*100:.1f}%".replace(".", ",")
  return `${(value * 100).toFixed(1)}%`.replace('.', ',')
}

/**
 * Format a number with two decimals: 2.98 → "2,98".
 * Null → "indisponivel".
 */
export function _fmt_number(value: number | null): string {
  if (value === null || value === undefined) {
    return 'indisponivel'
  }
  // Mirror Python: f"{value:.2f}".replace(".", ",")
  return value.toFixed(2).replace('.', ',')
}

/**
 * Validate a raw recommendation row and produce a strict RecommendationInput.
 * Throws if required fields are missing.
 */
export function buildLlmPayload(row: Record<string, unknown>): RecommendationInput {
  const required = [
    'campaign_id',
    'campaign_name',
    'recommended_action',
    'business_constraints_status',
    'approval_status',
  ] as const

  const missing = required.filter((k) => !(k in row)).sort()
  if (missing.length > 0) {
    throw new Error(`Missing required recommendation fields: ${missing.join(', ')}`)
  }

  const getNum = (k: string): number | null => {
    const v = row[k]
    if (v === undefined || v === null) return null
    if (typeof v === 'number') return v
    throw new Error(`Field ${k} must be a number or null, got ${typeof v}`)
  }
  const getStr = (k: string): string | null => {
    const v = row[k]
    if (v === undefined || v === null) return null
    if (typeof v === 'string') return v
    throw new Error(`Field ${k} must be a string or null, got ${typeof v}`)
  }

  const campaignId = row.campaign_id
  if (typeof campaignId !== 'number' && typeof campaignId !== 'string') {
    throw new Error('Field campaign_id must be number or string')
  }
  const campaignName = row.campaign_name
  if (typeof campaignName !== 'string') {
    throw new Error('Field campaign_name must be a string')
  }
  const recommendedAction = row.recommended_action
  if (typeof recommendedAction !== 'string') {
    throw new Error('Field recommended_action must be a string')
  }
  const businessConstraintsStatus = row.business_constraints_status
  if (typeof businessConstraintsStatus !== 'string') {
    throw new Error('Field business_constraints_status must be a string')
  }
  const approvalStatus = row.approval_status
  if (typeof approvalStatus !== 'string') {
    throw new Error('Field approval_status must be a string')
  }

  return {
    campaign_id: campaignId,
    campaign_name: campaignName,
    recommended_action: recommendedAction,
    change_percent: getNum('change_percent'),
    expected_incremental_cost: getNum('expected_incremental_cost'),
    expected_incremental_revenue: getNum('expected_incremental_revenue'),
    expected_marginal_roas: getNum('expected_marginal_roas'),
    projected_cos: getNum('projected_cos'),
    confidence_score: getNum('confidence_score'),
    risk_level: getStr('risk_level'),
    business_constraints_status: businessConstraintsStatus,
    constraints_reason: getStr('constraints_reason'),
    approval_status: approvalStatus,
    reason: getStr('reason'),
  }
}

/**
 * Deterministic explanation used as the LLM-off baseline.
 */
export function explainRecommendation(payload: RecommendationInput): RecommendationExplanation {
  const actionLabel = ACTION_LABELS[payload.recommended_action] ?? payload.recommended_action
  const blocked = payload.business_constraints_status === 'blocked'
  const review = payload.business_constraints_status === 'needs_human_review'
  const changeText = _fmt_pct(payload.change_percent)

  let headline: string
  let explanation: string
  if (blocked) {
    headline = `Acao bloqueada para ${payload.campaign_name}`
    explanation =
      `A acao calculada foi ${actionLabel}, mas ela nao deve seguir para execucao ` +
      `porque o guardrail retornou bloqueio: ${payload.constraints_reason ?? 'motivo nao informado'}.`
  } else {
    headline = `Candidata: ${actionLabel} em ${payload.campaign_name}`
    explanation =
      `A recomendacao calculada para a campanha ${payload.campaign_name} e ${actionLabel}. ` +
      `A mudanca sugerida e ${changeText}. Motivo estruturado: ${payload.reason ?? 'indisponivel'}.`
  }

  const expectedImpact =
    'Impacto esperado: custo incremental ' +
    `${_fmt_currency(payload.expected_incremental_cost)}, receita incremental ` +
    `${_fmt_currency(payload.expected_incremental_revenue)}, ROAS marginal ` +
    `${_fmt_number(payload.expected_marginal_roas)} e COS projetado ` +
    `${_fmt_pct(payload.projected_cos)}.`

  const riskAndConfidence =
    `Risco: ${payload.risk_level ?? 'indisponivel'}. ` +
    `Confianca estatistica: ${payload.confidence_score !== null && payload.confidence_score !== undefined ? payload.confidence_score : 'indisponivel'}.`

  const constraintsChecked =
    `Status dos guardrails: ${payload.business_constraints_status}. ` +
    `Razao: ${payload.constraints_reason ?? 'indisponivel'}.`

  const approvalNote =
    payload.approval_status === 'pending' || review
      ? 'Aprovacao humana pendente antes de qualquer execucao.'
      : `Status de aprovacao: ${payload.approval_status}.`

  const doNotExecuteReason = blocked ? payload.constraints_reason : null

  return {
    headline,
    explanation,
    expectedImpact,
    riskAndConfidence,
    constraintsChecked,
    approvalNote,
    doNotExecuteReason,
  }
}

/**
 * Serialize an explanation for logs or agent outputs.
 *
 * Field names are camelCase, matching the TS `RecommendationExplanation`
 * interface. Python's `explanation_as_dict` emits snake_case; this is the
 * deliberate divergence documented at the top of the file.
 */
export function explanationAsDict(
  explanation: RecommendationExplanation,
): Record<string, unknown> {
  return {
    headline: explanation.headline,
    explanation: explanation.explanation,
    expectedImpact: explanation.expectedImpact,
    riskAndConfidence: explanation.riskAndConfidence,
    constraintsChecked: explanation.constraintsChecked,
    approvalNote: explanation.approvalNote,
    doNotExecuteReason: explanation.doNotExecuteReason,
  }
}
