"""Analyze the Apice account using local enriched staging from 2026 onward."""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from statistics import mean
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STAGING_DIR = ROOT / "outputs" / "local_staging"
OUTPUT_DIR = ROOT / "outputs" / "analysis"
START_DATE = date(2026, 1, 1)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = [
        row
        for row in read_csv(STAGING_DIR / "apice_campaign_daily_enriched.csv")
        if parse_date(row["date"]) >= START_DATE
    ]
    hourly = [
        row
        for row in read_csv(STAGING_DIR / "apice_campaign_hourly_metrics.csv")
        if parse_date(row["date"]) >= START_DATE
    ]
    if not daily:
        raise RuntimeError("No daily Apice rows for 2026+")

    account = summarize_account(daily, hourly)
    campaigns = summarize_campaigns(daily)
    verdicts = [campaign_verdict(row) for row in campaigns]

    write_csv(OUTPUT_DIR / "apice_campaign_verdicts_2026.csv", verdicts)
    report = render_report(account, verdicts)
    (OUTPUT_DIR / "apice_account_analysis_2026.md").write_text(report, encoding="utf-8")
    (OUTPUT_DIR / "apice_account_analysis_2026.json").write_text(
        json.dumps({"account": account, "campaigns": verdicts}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(report)


def summarize_account(daily: list[dict[str, str]], hourly: list[dict[str, str]]) -> dict[str, Any]:
    latest_date = max(parse_date(row["date"]) for row in daily)
    latest_rows = [row for row in daily if parse_date(row["date"]) == latest_date]
    latest_hourly_date = max((parse_date(row["date"]) for row in hourly), default=None)
    latest_hourly = [
        row for row in hourly if latest_hourly_date and parse_date(row["date"]) == latest_hourly_date
    ]
    cost = total(daily, "cost")
    conversion_value = total(daily, "conversion_value")
    clicks = total(daily, "clicks")
    impressions = total(daily, "impressions")
    conversions = total(daily, "conversions")
    ads_conversion_value = total(daily, "ads_conversion_value")
    ga4_purchase_revenue = total(daily, "ga4_purchase_revenue")
    business_revenue = total(daily, "business_revenue")
    latest_cost = total(latest_rows, "cost")
    latest_ads_value = total(latest_rows, "ads_conversion_value")
    latest_ga4_value = total(latest_rows, "ga4_purchase_revenue")
    return {
        "period_start": START_DATE.isoformat(),
        "period_end": latest_date.isoformat(),
        "rows": len(daily),
        "campaigns": len({row["campaign_id"] for row in daily}),
        "cost": round(cost, 2),
        "conversion_value": round(ads_conversion_value or conversion_value, 2),
        "ads_conversion_value": round(ads_conversion_value or conversion_value, 2),
        "ga4_purchase_revenue": round(ga4_purchase_revenue, 2),
        "business_revenue": round(business_revenue or ga4_purchase_revenue, 2),
        "roas": safe_div(business_revenue or ga4_purchase_revenue, cost),
        "ga4_roas": safe_div(ga4_purchase_revenue, cost),
        "ads_roas": safe_div(ads_conversion_value or conversion_value, cost),
        "impressions": int(impressions),
        "clicks": int(clicks),
        "ctr": safe_div(clicks, impressions),
        "conversions": round(conversions, 2),
        "cvr": safe_div(conversions, clicks),
        "latest_date": latest_date.isoformat(),
        "latest_campaigns": len({row["campaign_id"] for row in latest_rows}),
        "latest_cost": round(latest_cost, 2),
        "latest_conversion_value": round(latest_ads_value, 2),
        "latest_ads_conversion_value": round(latest_ads_value, 2),
        "latest_ga4_purchase_revenue": round(latest_ga4_value, 2),
        "latest_roas": safe_div(latest_ga4_value, latest_cost),
        "latest_ga4_roas": safe_div(latest_ga4_value, latest_cost),
        "latest_ads_roas": safe_div(latest_ads_value, latest_cost),
        "latest_with_budget": count_present(latest_rows, "budget"),
        "latest_with_target": sum(bool(row.get("target_roas") or row.get("target_cpa")) for row in latest_rows),
        "latest_hourly_date": latest_hourly_date.isoformat() if latest_hourly_date else None,
        "latest_hourly_rows": len(latest_hourly),
        "latest_hourly_campaigns": len({row["campaign_id"] for row in latest_hourly}),
        "latest_hourly_hours": sorted({int(row["hour"]) for row in latest_hourly}) if latest_hourly else [],
        "latest_hourly_cost": round(total(hourly, "cost_brl"), 2),
        "latest_hourly_conversion_value": round(total(hourly, "conversion_value"), 2),
    }


def summarize_campaigns(daily: list[dict[str, str]]) -> list[dict[str, Any]]:
    by_campaign: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in daily:
        by_campaign[row["campaign_id"]].append(row)

    summaries = []
    for campaign_id, rows in by_campaign.items():
        rows.sort(key=lambda row: parse_date(row["date"]))
        latest = rows[-1]
        cost = total(rows, "cost")
        conversion_value = total(rows, "conversion_value")
        ads_conversion_value = total(rows, "ads_conversion_value") or conversion_value
        ga4_purchase_revenue = total(rows, "ga4_purchase_revenue")
        business_revenue = total(rows, "business_revenue") or ga4_purchase_revenue
        clicks = total(rows, "clicks")
        impressions = total(rows, "impressions")
        conversions = total(rows, "conversions")
        budget_values = [number(row.get("budget")) for row in rows if number(row.get("budget")) > 0]
        target_roas_values = [
            number(row.get("target_roas")) for row in rows if number(row.get("target_roas")) > 0
        ]
        target_cpa_values = [
            number(row.get("target_cpa")) for row in rows if number(row.get("target_cpa")) > 0
        ]
        latest_cost = number(latest.get("cost"))
        latest_budget = number(latest.get("budget"))
        summaries.append(
            {
                "campaign_id": campaign_id,
                "campaign_name": latest["campaign_name"],
                "status": latest.get("status") or "UNKNOWN",
                "bidding_strategy": latest.get("bidding_strategy") or "",
                "days": len(rows),
                "first_date": parse_date(rows[0]["date"]).isoformat(),
                "last_date": parse_date(latest["date"]).isoformat(),
                "cost": round(cost, 2),
                "conversion_value": round(conversion_value, 2),
                "ads_conversion_value": round(ads_conversion_value, 2),
                "ga4_purchase_revenue": round(ga4_purchase_revenue, 2),
                "business_revenue": round(business_revenue, 2),
                "roas": safe_div(business_revenue, cost),
                "ga4_roas": safe_div(ga4_purchase_revenue, cost),
                "ads_roas": safe_div(ads_conversion_value, cost),
                "impressions": int(impressions),
                "clicks": int(clicks),
                "ctr": safe_div(clicks, impressions),
                "conversions": round(conversions, 2),
                "cvr": safe_div(conversions, clicks),
                "avg_budget": round(mean(budget_values), 2) if budget_values else 0,
                "latest_budget": latest_budget,
                "avg_budget_consumption": safe_mean(
                    number(row.get("budget_consumption")) for row in rows
                ),
                "latest_budget_consumption": safe_div(latest_cost, latest_budget),
                "target_roas": round(mean(target_roas_values), 4) if target_roas_values else 0,
                "target_cpa": round(mean(target_cpa_values), 2) if target_cpa_values else 0,
                "latest_cost": round(latest_cost, 2),
                "latest_conversion_value": round(number(latest.get("conversion_value")), 2),
                "latest_ads_conversion_value": round(number(latest.get("ads_conversion_value")), 2),
                "latest_ga4_purchase_revenue": round(number(latest.get("ga4_purchase_revenue")), 2),
                "latest_roas": safe_div(number(latest.get("business_revenue")), latest_cost),
                "latest_ga4_roas": safe_div(number(latest.get("ga4_purchase_revenue")), latest_cost),
                "latest_ads_roas": safe_div(number(latest.get("ads_conversion_value")), latest_cost),
            }
        )
    return sorted(summaries, key=lambda row: row["cost"], reverse=True)


def campaign_verdict(row: dict[str, Any]) -> dict[str, Any]:
    roas = row["roas"]
    ads_roas = row["ads_roas"]
    target_roas = row["target_roas"]
    latest_budget_consumption = row["latest_budget_consumption"]
    status = row["status"]
    action = "monitor"
    verdict = "monitorar"
    reason = "sem sinal forte suficiente"
    risk = "medium"

    if status != "ENABLED":
        action = "ignore_paused"
        verdict = "pausada"
        reason = "campanha nao esta enabled"
        risk = "low"
    elif target_roas and ads_roas >= target_roas * 1.15 and latest_budget_consumption >= 0.75:
        action = "scale_or_lower_troas"
        verdict = "boa candidata a escala"
        reason = "ROAS Ads acima da meta e consumo alto de budget"
        risk = "low"
    elif target_roas and ads_roas < target_roas * 0.80:
        action = "increase_troas_or_reduce_budget"
        verdict = "corrigir eficiencia"
        reason = "ROAS Ads abaixo da meta real"
        risk = "high"
    elif target_roas and ads_roas >= target_roas:
        action = "monitor_or_increment"
        verdict = "saudavel"
        reason = "ROAS Ads acima da meta real"
        risk = "low"
    elif row["target_cpa"] and row["conversions"] > 0:
        action = "monitor_tcpa"
        verdict = "avaliar por CPA"
        reason = "campanha usa meta de CPA; analise de ROAS e secundaria"
        risk = "medium"
    elif row["cost"] > 500 and row["conversion_value"] <= 0:
        action = "reduce_or_pause"
        verdict = "risco de desperdicio"
        reason = "gasto com valor de conversao nulo no periodo"
        risk = "high"

    return {
        **row,
        "recommended_action": action,
        "verdict": verdict,
        "reason": reason,
        "risk": risk,
    }


def render_report(account: dict[str, Any], campaigns: list[dict[str, Any]]) -> str:
    enabled = [row for row in campaigns if row["status"] == "ENABLED"]
    top_cost = enabled[:10]
    action_counts = Counter(row["recommended_action"] for row in enabled)
    lines = [
        "# Analise Apice 2026",
        "",
        "## Conta",
        "",
        f"Periodo: {account['period_start']} a {account['period_end']}",
        f"Campanhas com dados: {account['campaigns']}",
        f"Custo: R$ {account['cost']:,.2f}",
        f"Receita GA4: R$ {account['ga4_purchase_revenue']:,.2f}",
        f"Valor de conversao Ads: R$ {account['ads_conversion_value']:,.2f}",
        f"ROAS GA4: {account['ga4_roas']:.2f}",
        f"ROAS Ads: {account['ads_roas']:.2f}",
        f"Cliques: {account['clicks']:,}",
        f"Impressoes: {account['impressions']:,}",
        f"CTR: {account['ctr']:.2%}",
        f"Conversoes: {account['conversions']:,.2f}",
        f"CVR: {account['cvr']:.2%}",
        "",
        "## Ultimo Dia",
        "",
        f"Data: {account['latest_date']}",
        f"Campanhas: {account['latest_campaigns']}",
        f"Custo: R$ {account['latest_cost']:,.2f}",
        f"Receita GA4: R$ {account['latest_ga4_purchase_revenue']:,.2f}",
        f"Valor Ads: R$ {account['latest_ads_conversion_value']:,.2f}",
        f"ROAS GA4: {account['latest_ga4_roas']:.2f}",
        f"ROAS Ads: {account['latest_ads_roas']:.2f}",
        f"Campanhas com budget real: {account['latest_with_budget']}",
        f"Campanhas com alguma meta real: {account['latest_with_target']}",
        "",
        "## Intraday",
        "",
        f"Data horaria mais recente: {account['latest_hourly_date']}",
        f"Linhas horarias recentes: {account['latest_hourly_rows']}",
        f"Campanhas horarias recentes: {account['latest_hourly_campaigns']}",
        f"Horas cobertas: {account['latest_hourly_hours']}",
        "",
        "## Vereditos Enabled",
        "",
        json.dumps(dict(action_counts), ensure_ascii=False),
        "",
        "## Top Campanhas Enabled Por Custo",
        "",
    ]
    for row in top_cost:
        lines.append(
            "- "
            + f"{row['campaign_name']} | custo R$ {row['cost']:,.2f} | "
            + f"ROAS GA4 {row['ga4_roas']:.2f} | ROAS Ads {row['ads_roas']:.2f} | meta ROAS {row['target_roas']:.2f} | "
            + f"budget atual R$ {row['latest_budget']:,.2f} | "
            + f"acao {row['recommended_action']} | {row['reason']}"
        )
    return "\n".join(lines) + "\n"


def read_csv(path: Path) -> list[dict[str, str]]:
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


def parse_date(value: str) -> date:
    return date.fromisoformat(value[:10])


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def total(rows: list[dict[str, Any]], key: str) -> float:
    return sum(number(row.get(key)) for row in rows)


def count_present(rows: list[dict[str, Any]], key: str) -> int:
    return sum(number(row.get(key)) > 0 for row in rows)


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def safe_mean(values: Any) -> float:
    numeric = [value for value in values if value]
    return mean(numeric) if numeric else 0.0


if __name__ == "__main__":
    main()
