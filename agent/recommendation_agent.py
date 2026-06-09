"""LLM-facing recommendation explanation helpers for GoTrends v2.

This module does not call an LLM. It prepares and validates the payload that an
LLM may explain, and provides a deterministic fallback explanation.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class RecommendationInput:
    campaign_id: int | str
    campaign_name: str
    recommended_action: str
    change_percent: float | None
    expected_incremental_cost: float | None
    expected_incremental_revenue: float | None
    expected_marginal_roas: float | None
    projected_cos: float | None
    confidence_score: int | None
    risk_level: str | None
    business_constraints_status: str
    constraints_reason: str | None
    approval_status: str
    reason: str | None


@dataclass(frozen=True)
class RecommendationExplanation:
    headline: str
    explanation: str
    expected_impact: str
    risk_and_confidence: str
    constraints_checked: str
    approval_note: str
    do_not_execute_reason: str | None


ACTION_LABELS = {
    "increase_budget": "aumentar budget",
    "increase_troas_or_reduce_budget": "aumentar tROAS ou reduzir budget",
    "optimize_efficiency": "otimizar eficiencia",
    "improve_ads_or_terms": "melhorar anuncios ou termos",
    "review_landing_or_offer": "revisar landing page ou oferta",
    "monitor": "monitorar",
}


def _fmt_currency(value: float | None) -> str:
    if value is None:
        return "indisponivel"
    return f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _fmt_pct(value: float | None) -> str:
    if value is None:
        return "indisponivel"
    return f"{value * 100:.1f}%".replace(".", ",")


def _fmt_number(value: float | None) -> str:
    if value is None:
        return "indisponivel"
    return f"{value:.2f}".replace(".", ",")


def build_llm_payload(row: dict[str, Any]) -> RecommendationInput:
    """Build the strict LLM input from a recommendation row."""
    required = {
        "campaign_id",
        "campaign_name",
        "recommended_action",
        "business_constraints_status",
        "approval_status",
    }
    missing = sorted(required - set(row))
    if missing:
        raise ValueError(f"Missing required recommendation fields: {', '.join(missing)}")

    return RecommendationInput(
        campaign_id=row["campaign_id"],
        campaign_name=row["campaign_name"],
        recommended_action=row["recommended_action"],
        change_percent=row.get("change_percent"),
        expected_incremental_cost=row.get("expected_incremental_cost"),
        expected_incremental_revenue=row.get("expected_incremental_revenue"),
        expected_marginal_roas=row.get("expected_marginal_roas"),
        projected_cos=row.get("projected_cos"),
        confidence_score=row.get("confidence_score"),
        risk_level=row.get("risk_level"),
        business_constraints_status=row["business_constraints_status"],
        constraints_reason=row.get("constraints_reason"),
        approval_status=row["approval_status"],
        reason=row.get("reason"),
    )


def explain_recommendation(payload: RecommendationInput) -> RecommendationExplanation:
    """Generate a deterministic explanation for review or LLM fallback."""
    action_label = ACTION_LABELS.get(payload.recommended_action, payload.recommended_action)
    blocked = payload.business_constraints_status == "blocked"
    review = payload.business_constraints_status == "needs_human_review"
    change_text = _fmt_pct(payload.change_percent)

    if blocked:
        headline = f"Acao bloqueada para {payload.campaign_name}"
        explanation = (
            f"A acao calculada foi {action_label}, mas ela nao deve seguir para execucao "
            f"porque o guardrail retornou bloqueio: {payload.constraints_reason or 'motivo nao informado'}."
        )
    else:
        headline = f"Candidata: {action_label} em {payload.campaign_name}"
        explanation = (
            f"A recomendacao calculada para a campanha {payload.campaign_name} e {action_label}. "
            f"A mudanca sugerida e {change_text}. Motivo estruturado: {payload.reason or 'indisponivel'}."
        )

    expected_impact = (
        "Impacto esperado: custo incremental "
        f"{_fmt_currency(payload.expected_incremental_cost)}, receita incremental "
        f"{_fmt_currency(payload.expected_incremental_revenue)}, ROAS marginal "
        f"{_fmt_number(payload.expected_marginal_roas)} e COS projetado "
        f"{_fmt_pct(payload.projected_cos)}."
    )
    risk_and_confidence = (
        f"Risco: {payload.risk_level or 'indisponivel'}. "
        f"Confianca estatistica: {payload.confidence_score if payload.confidence_score is not None else 'indisponivel'}."
    )
    constraints_checked = (
        f"Status dos guardrails: {payload.business_constraints_status}. "
        f"Razao: {payload.constraints_reason or 'indisponivel'}."
    )
    approval_note = (
        "Aprovacao humana pendente antes de qualquer execucao."
        if payload.approval_status == "pending" or review
        else f"Status de aprovacao: {payload.approval_status}."
    )
    do_not_execute_reason = payload.constraints_reason if blocked else None

    return RecommendationExplanation(
        headline=headline,
        explanation=explanation,
        expected_impact=expected_impact,
        risk_and_confidence=risk_and_confidence,
        constraints_checked=constraints_checked,
        approval_note=approval_note,
        do_not_execute_reason=do_not_execute_reason,
    )


def explanation_as_dict(explanation: RecommendationExplanation) -> dict[str, Any]:
    """Serialize explanation for logs or agent outputs."""
    return asdict(explanation)
