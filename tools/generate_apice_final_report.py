"""Generate final GoTrends-style report for Apice."""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "outputs" / "final_report"
LOCAL_MODELS_DIR = ROOT / "outputs" / "local_models"
ANALYSIS_DIR = ROOT / "outputs" / "analysis"
API_DIR = ROOT / "outputs" / "apice_google_ads"


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    recommendations = read_csv(LOCAL_MODELS_DIR / "apice_final_recommendations.csv")
    campaign_features = read_csv(LOCAL_MODELS_DIR / "apice_campaign_features.csv")
    daily_metrics = read_csv(LOCAL_MODELS_DIR / "apice_daily_metrics_2026.csv")
    account_analysis = json.loads((ANALYSIS_DIR / "apice_account_analysis_2026.json").read_text())
    changes = read_csv(API_DIR / "apice_change_history.csv")

    feature_by_campaign = {row["campaign_id"]: row for row in campaign_features}
    changes_by_campaign = map_changes_by_campaign(changes)
    final_rows = []
    for rec in recommendations:
        feature = feature_by_campaign.get(rec["campaign_id"], {})
        recent_changes = changes_by_campaign.get(rec["campaign_id"], [])
        final_rows.append(final_output_row(rec, feature, recent_changes))

    write_csv(OUTPUT_DIR / "apice_final_recommendations_project_output.csv", final_rows)
    report = render_report(account_analysis["account"], final_rows, changes)
    (OUTPUT_DIR / "apice_final_report.md").write_text(report, encoding="utf-8")
    (OUTPUT_DIR / "apice_final_report.json").write_text(
        json.dumps({"account": account_analysis["account"], "recommendations": final_rows}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(report)


def final_output_row(rec: dict[str, str], feature: dict[str, str], changes: list[dict[str, str]]) -> dict[str, Any]:
    action = rec["recommended_action"]
    status = rec["business_constraints_status"]
    priority = int(float(rec["priority_score"] or 0))
    human_note = approval_note(action, status, changes)
    return {
        "campaign_id": rec["campaign_id"],
        "campaign_name": rec["campaign_name"],
        "status": rec["status"],
        "bidding_strategy": rec["bidding_strategy"],
        "recommended_action": action,
        "business_constraints_status": status,
        "constraints_reason": rec["constraints_reason"],
        "priority_score": priority,
        "risk_level": rec["risk_level"],
        "reason": rec["reason"],
        "cost_day": money(rec["cost"]),
        "ads_conversion_value_day": money(rec["ads_conversion_value"] or rec["conversion_value"]),
        "ga4_purchase_revenue_day": money(rec["ga4_purchase_revenue"]),
        "business_revenue_day": money(rec["business_revenue"]),
        "ads_roas_day": rounded(rec["ads_roas"]),
        "ga4_roas_day": rounded(rec["ga4_roas"]),
        "business_roas_day": rounded(rec["roas"]),
        "business_roas_7d": rounded(rec["roas_7d"]),
        "business_roas_28d": rounded(rec["roas_28d"]),
        "ads_roas_7d": rounded(rec["ads_roas_7d"]),
        "ads_roas_28d": rounded(rec["ads_roas_28d"]),
        "target_roas": rounded(rec["target_roas"]),
        "cpa_day": money(rec["cpa"]),
        "cpa_28d": money(rec["cpa_28d"]),
        "target_cpa": money(rec["target_cpa"]),
        "budget": money(rec["budget"]),
        "budget_consumption": rounded(rec["budget_consumption"]),
        "forecast_eod_cost": money(rec["forecast_eod_cost"]),
        "forecast_eod_roas": rounded(rec["forecast_eod_roas"]),
        "forecast_budget_consumption": rounded(rec["forecast_budget_consumption"]),
        "trend_status": rec["trend_status"],
        "business_trend_status": rec["business_trend_status"],
        "data_sufficiency": rec["data_sufficiency"],
        "efficiency_status": rec["efficiency_status"],
        "saturation_level": rec["saturation_level"],
        "recent_change_count": len(changes),
        "recent_change_types": ", ".join(sorted({row["change_resource_type"] for row in changes}))[:250],
        "approval_note": human_note,
    }


def approval_note(action: str, status: str, changes: list[dict[str, str]]) -> str:
    if status == "blocked":
        return "Nao executar automaticamente; guardrail bloqueou esta acao."
    if changes:
        return "Revisar mudancas recentes antes de aprovar."
    if action == "increase_troas_or_reduce_budget":
        return "Candidata prioritaria: revisar meta, budget e mix de produtos/termos."
    if action == "reduce_budget_or_fix_cpa":
        return "Candidata CPA: revisar meta de CPA e qualidade do trafego."
    return "Monitorar sem alteracao."


def render_report(account: dict[str, Any], rows: list[dict[str, Any]], changes: list[dict[str, str]]) -> str:
    action_counts = Counter(row["recommended_action"] for row in rows)
    guardrail_counts = Counter(row["business_constraints_status"] for row in rows)
    change_counts = Counter(row["change_resource_type"] for row in changes)
    allowed = [row for row in rows if row["business_constraints_status"] == "needs_human_review"]
    blocked = [row for row in rows if row["business_constraints_status"] == "blocked"]

    lines = [
        "# GoTrends - Relatorio Final Apice",
        "",
        "## Resumo Executivo",
        "",
        f"Periodo analisado: {account['period_start']} a {account['period_end']}",
        f"ROAS GA4 agregado 2026: {account['ga4_roas']:.2f}",
        f"ROAS Ads agregado 2026: {account['ads_roas']:.2f}",
        f"Custo 2026: R$ {account['cost']:,.2f}",
        f"Receita GA4 2026: R$ {account['ga4_purchase_revenue']:,.2f}",
        f"Valor de conversao Ads 2026: R$ {account['ads_conversion_value']:,.2f}",
        f"Ultimo dia ({account['latest_date']}): ROAS GA4 {account['latest_ga4_roas']:.2f}, ROAS Ads {account['latest_ads_roas']:.2f}, custo R$ {account['latest_cost']:,.2f}",
        "",
        "Veredito: o relatorio agora separa ROAS de negocio (GA4 purchase_revenue / custo) e ROAS tecnico do Google Ads. As metas tROAS continuam sendo avaliadas contra o valor de conversao Ads, enquanto o ROAS GA4 orienta a leitura executiva de receita.",
        "",
        "## Distribuicao de Acoes",
        "",
        json.dumps(dict(action_counts), ensure_ascii=False),
        "",
        "## Guardrails",
        "",
        json.dumps(dict(guardrail_counts), ensure_ascii=False),
        "",
        "## Mudancas Recentes",
        "",
        f"Eventos exportados desde 2026-05-12: {len(changes)}",
        json.dumps(dict(change_counts.most_common(10)), ensure_ascii=False),
        "",
        "## Recomendacao Liberada Para Revisao",
        "",
    ]
    for row in allowed:
        lines.extend(recommendation_block(row))

    lines.extend(["", "## Recomendacoes Bloqueadas Por Guardrail", ""])
    for row in blocked:
        lines.append(
            f"- {row['campaign_name']}: {row['recommended_action']} | {row['constraints_reason']} | "
            f"ROAS GA4 {row['ga4_roas_day']} | ROAS Ads {row['ads_roas_day']} vs meta {row['target_roas']} | prioridade {row['priority_score']}"
        )
    return "\n".join(lines) + "\n"


def recommendation_block(row: dict[str, Any]) -> list[str]:
    return [
        f"### {row['campaign_name']}",
        "",
        f"Acao: {row['recommended_action']}",
        f"Motivo: {row['reason']}",
        f"Prioridade: {row['priority_score']}",
        f"Risco: {row['risk_level']}",
        f"ROAS GA4 dia: {row['ga4_roas_day']}",
        f"ROAS GA4 7d: {row['business_roas_7d']}",
        f"ROAS GA4 28d: {row['business_roas_28d']}",
        f"ROAS Ads dia: {row['ads_roas_day']}",
        f"ROAS Ads 7d: {row['ads_roas_7d']}",
        f"ROAS Ads 28d: {row['ads_roas_28d']}",
        f"Meta tROAS: {row['target_roas']}",
        f"Budget: R$ {row['budget']}",
        f"Consumo de budget no dia: {row['budget_consumption']}",
        f"Forecast ROAS EOD: {row['forecast_eod_roas']}",
        f"Forecast consumo budget EOD: {row['forecast_budget_consumption']}",
        f"Suficiencia de dados: {row['data_sufficiency']}",
        f"Tendencia Ads vs meta: {row['trend_status']}",
        f"Tendencia GA4: {row['business_trend_status']}",
        f"Saturacao: {row['saturation_level']}",
        f"Nota de aprovacao: {row['approval_note']}",
        "",
    ]


def map_changes_by_campaign(changes: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    mapped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in changes:
        campaign_resource = row.get("campaign_resource", "")
        campaign_id = campaign_resource.split("/")[-1] if "/" in campaign_resource else ""
        if campaign_id:
            mapped[campaign_id].append(row)
    return mapped


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def rounded(value: Any) -> float:
    return round(number(value), 4)


def money(value: Any) -> float:
    return round(number(value), 2)


if __name__ == "__main__":
    main()
