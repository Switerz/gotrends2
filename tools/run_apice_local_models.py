"""Run local GoTrends models for Apice using Metabase + Google Ads API staging."""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import mean, median
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STAGING_DIR = ROOT / "outputs" / "local_staging"
OUTPUT_DIR = ROOT / "outputs" / "local_models"
START_DATE = date(2026, 1, 1)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    daily = [
        normalize_daily(row)
        for row in read_csv(STAGING_DIR / "apice_campaign_daily_enriched.csv")
        if parse_date(row["date"]) >= START_DATE
    ]
    hourly = [
        normalize_hourly(row)
        for row in read_csv(STAGING_DIR / "apice_campaign_hourly_metrics.csv")
        if parse_date(row["date"]) >= START_DATE
    ]
    if not daily:
        raise RuntimeError("No Apice daily rows from 2026 onward. Build local staging first.")

    daily_metrics = build_daily_metrics(daily)
    intraday_forecast = build_intraday_forecast(hourly)
    campaign_features = build_campaign_features(daily_metrics, intraday_forecast)
    recommendations = apply_local_guardrails(campaign_features)

    write_csv(OUTPUT_DIR / "apice_daily_metrics_2026.csv", daily_metrics)
    write_csv(OUTPUT_DIR / "apice_intraday_forecast.csv", intraday_forecast)
    write_csv(OUTPUT_DIR / "apice_campaign_features.csv", campaign_features)
    write_csv(OUTPUT_DIR / "apice_final_recommendations.csv", recommendations)

    summary = build_summary(daily_metrics, intraday_forecast, recommendations)
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


def build_daily_metrics(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_campaign: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_campaign[str(row["campaign_id"])].append(row)

    out = []
    for campaign_rows in by_campaign.values():
        campaign_rows.sort(key=lambda row: row["date"])
        for idx, row in enumerate(campaign_rows):
            prior_7 = campaign_rows[max(0, idx - 7) : idx]
            prior_28 = campaign_rows[max(0, idx - 28) : idx]
            roas_7d = roas(prior_7)
            roas_28d = roas(prior_28)
            ads_roas_7d = roas(prior_7, value_key="ads_conversion_value")
            ads_roas_28d = roas(prior_28, value_key="ads_conversion_value")
            cpa_28d = cpa(prior_28)
            target_roas = row["target_roas"]
            target_cpa = row["target_cpa"]
            out.append(
                {
                    **row,
                    "budget_consumption": safe_div(row["cost"], row["budget"]),
                    "roas_7d": roas_7d,
                    "roas_28d": roas_28d,
                    "ads_roas_7d": ads_roas_7d,
                    "ads_roas_28d": ads_roas_28d,
                    "cpa": safe_div(row["cost"], row["conversions"]),
                    "cpa_28d": cpa_28d,
                    "target_roas_gap": safe_div(row["ads_roas"], target_roas) - 1
                    if target_roas
                    else "",
                    "business_target_roas_gap": safe_div(row["ga4_roas"], target_roas) - 1
                    if target_roas
                    else "",
                    "target_cpa_gap": safe_div(safe_div(row["cost"], row["conversions"]), target_cpa)
                    - 1
                    if target_cpa and row["conversions"]
                    else "",
                    "trend_status": trend_status(row, ads_roas_28d, cpa_28d),
                    "business_trend_status": business_trend_status(row, roas_28d),
                    "data_sufficiency": data_sufficiency(prior_28),
                }
            )
    return out


def build_intraday_forecast(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    latest_date = max(row["date"] for row in rows)
    completed_rows = [row for row in rows if row["date"] < latest_date]
    latest_rows = [row for row in rows if row["date"] == latest_date]
    curves = hourly_curves(completed_rows)

    by_campaign: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in latest_rows:
        by_campaign[str(row["campaign_id"])].append(row)

    out = []
    for campaign_id, campaign_rows in by_campaign.items():
        campaign_rows.sort(key=lambda row: row["hour"])
        observed_hour = max(row["hour"] for row in campaign_rows)
        observed_cost = sum(row["cost"] for row in campaign_rows)
        observed_value = sum(row["conversion_value"] for row in campaign_rows)
        observed_clicks = sum(row["clicks"] for row in campaign_rows)
        observed_impressions = sum(row["impressions"] for row in campaign_rows)
        key = (campaign_id, observed_hour)
        cost_fraction = curves["cost"].get(key) or curves["cost_type"].get(observed_hour) or 1
        value_fraction = curves["value"].get(key) or curves["value_type"].get(observed_hour) or 1
        forecast_cost = observed_cost / cost_fraction if cost_fraction else observed_cost
        forecast_value = observed_value / value_fraction if value_fraction else observed_value
        latest = campaign_rows[-1]
        out.append(
            {
                "date": latest_date.isoformat(),
                "company": latest["company"],
                "campaign_id": campaign_id,
                "campaign_name": latest["campaign_name"],
                "status": latest["status"],
                "hour_observed": observed_hour,
                "observed_cost": round(observed_cost, 2),
                "observed_conversion_value": round(observed_value, 2),
                "observed_clicks": int(observed_clicks),
                "observed_impressions": int(observed_impressions),
                "forecast_eod_cost": round(forecast_cost, 2),
                "forecast_eod_conversion_value": round(forecast_value, 2),
                "forecast_eod_roas": safe_div(forecast_value, forecast_cost),
                "cost_completion_fraction": cost_fraction,
                "value_completion_fraction": value_fraction,
                "budget": latest["budget"],
                "target_roas": latest["target_roas"],
                "target_cpa": latest["target_cpa"],
                "forecast_budget_consumption": safe_div(forecast_cost, latest["budget"]),
            }
        )
    return sorted(out, key=lambda row: row["forecast_eod_cost"], reverse=True)


def build_campaign_features(
    daily_metrics: list[dict[str, Any]],
    intraday: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    latest_date = max(row["date"] for row in daily_metrics)
    latest_rows = [row for row in daily_metrics if row["date"] == latest_date]
    intraday_by_campaign = {str(row["campaign_id"]): row for row in intraday}
    out = []
    for row in latest_rows:
        forecast = intraday_by_campaign.get(str(row["campaign_id"]), {})
        efficiency_status = classify_efficiency(row)
        saturation_level = classify_saturation(row, forecast)
        recommended_action, reason = recommend_action(row, efficiency_status, saturation_level)
        out.append(
            {
                **row,
                "forecast_eod_cost": forecast.get("forecast_eod_cost", ""),
                "forecast_eod_roas": forecast.get("forecast_eod_roas", ""),
                "forecast_budget_consumption": forecast.get("forecast_budget_consumption", ""),
                "efficiency_status": efficiency_status,
                "saturation_level": saturation_level,
                "recommended_action": recommended_action,
                "reason": reason,
                "risk_level": risk_level(row, recommended_action, saturation_level),
                "priority_score": priority_score(row, recommended_action),
            }
        )
    return sorted(out, key=lambda row: row["priority_score"], reverse=True)


def apply_local_guardrails(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    budget_rank = 0
    target_rank = 0
    for row in rows:
        action = row["recommended_action"]
        status = "needs_human_review"
        reason = "human_approval_required"
        change_percent = 0.0
        if row["status"] != "ENABLED":
            status = "blocked"
            reason = "campaign_not_enabled"
        elif action == "increase_budget":
            budget_rank += 1
            change_percent = 0.15
            if budget_rank > 3:
                status = "blocked"
                reason = "blocked_by_daily_budget_change_limit"
        elif action in {"increase_troas_or_reduce_budget", "reduce_budget_or_fix_cpa"}:
            target_rank += 1
            change_percent = -0.15
            if target_rank > 1:
                status = "blocked"
                reason = "blocked_by_daily_target_change_limit"
        elif action == "monitor":
            status = "not_applicable"
            reason = "monitor_no_action"

        out.append(
            {
                **row,
                "change_percent": change_percent,
                "business_constraints_status": status,
                "constraints_reason": reason,
                "approval_status": "pending" if status == "needs_human_review" else "",
            }
        )
    return out


def hourly_curves(rows: list[dict[str, Any]]) -> dict[str, dict[Any, float]]:
    totals: dict[tuple[str, date], dict[str, float]] = defaultdict(lambda: {"cost": 0, "value": 0})
    cumulative: dict[tuple[str, date, int], dict[str, float]] = {}
    for row in rows:
        key = (str(row["campaign_id"]), row["date"])
        totals[key]["cost"] += row["cost"]
        totals[key]["value"] += row["conversion_value"]

    grouped: dict[tuple[str, date], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row["campaign_id"]), row["date"])].append(row)

    cost_fractions: dict[tuple[str, int], list[float]] = defaultdict(list)
    value_fractions: dict[tuple[str, int], list[float]] = defaultdict(list)
    type_cost_fractions: dict[int, list[float]] = defaultdict(list)
    type_value_fractions: dict[int, list[float]] = defaultdict(list)
    for key, grouped_rows in grouped.items():
        campaign_id, day = key
        grouped_rows.sort(key=lambda row: row["hour"])
        running_cost = 0.0
        running_value = 0.0
        total_cost = totals[key]["cost"]
        total_value = totals[key]["value"]
        for row in grouped_rows:
            running_cost += row["cost"]
            running_value += row["conversion_value"]
            hour = row["hour"]
            if total_cost > 0:
                fraction = min(1.0, running_cost / total_cost)
                cost_fractions[(campaign_id, hour)].append(fraction)
                type_cost_fractions[hour].append(fraction)
            if total_value > 0:
                fraction = min(1.0, running_value / total_value)
                value_fractions[(campaign_id, hour)].append(fraction)
                type_value_fractions[hour].append(fraction)

    return {
        "cost": {key: median(values) for key, values in cost_fractions.items()},
        "value": {key: median(values) for key, values in value_fractions.items()},
        "cost_type": {key: median(values) for key, values in type_cost_fractions.items()},
        "value_type": {key: median(values) for key, values in type_value_fractions.items()},
    }


def classify_efficiency(row: dict[str, Any]) -> str:
    if row["target_roas"]:
        if row["ads_roas"] >= row["target_roas"] * 1.15:
            return "above_target"
        if row["ads_roas"] >= row["target_roas"] * 0.95:
            return "near_target"
        return "below_target"
    if row["target_cpa"] and row["conversions"]:
        current_cpa = safe_div(row["cost"], row["conversions"])
        if current_cpa <= row["target_cpa"]:
            return "above_target"
        if current_cpa <= row["target_cpa"] * 1.15:
            return "near_target"
        return "below_target"
    return "missing_target"


def classify_saturation(row: dict[str, Any], forecast: dict[str, Any]) -> str:
    budget_consumption = number(forecast.get("forecast_budget_consumption")) or row["budget_consumption"]
    impression_share = row["impression_share"]
    if impression_share and impression_share >= 0.90:
        return "high"
    if budget_consumption >= 0.95:
        return "budget_capped"
    if budget_consumption >= 0.75:
        return "moderate"
    return "low"


def recommend_action(row: dict[str, Any], efficiency_status: str, saturation_level: str) -> tuple[str, str]:
    if row["status"] != "ENABLED":
        return "monitor", "campaign_not_enabled"
    if row["target_cpa"] and not row["target_roas"]:
        if efficiency_status == "below_target":
            return "reduce_budget_or_fix_cpa", "CPA acima da meta real"
        return "monitor", "campanha tCPA dentro ou perto da meta"
    if efficiency_status == "below_target":
        return "increase_troas_or_reduce_budget", "ROAS abaixo da meta real"
    if efficiency_status == "above_target" and saturation_level in {"budget_capped", "moderate"}:
        return "increase_budget", "ROAS acima da meta real e budget consumido"
    return "monitor", "sem sinal forte suficiente"


def risk_level(row: dict[str, Any], action: str, saturation_level: str) -> str:
    if action in {"increase_troas_or_reduce_budget", "reduce_budget_or_fix_cpa"}:
        return "high"
    if saturation_level in {"budget_capped", "high"}:
        return "medium"
    if row["data_sufficiency"] in {"insufficient", "low"}:
        return "medium"
    return "low"


def priority_score(row: dict[str, Any], action: str) -> int:
    base = min(100, int(row["cost"] / 100))
    if action in {"increase_troas_or_reduce_budget", "reduce_budget_or_fix_cpa"}:
        return min(100, base + 40)
    if action == "increase_budget":
        return min(100, base + 25)
    return base


def build_summary(
    daily: list[dict[str, Any]],
    intraday: list[dict[str, Any]],
    recommendations: list[dict[str, Any]],
) -> dict[str, Any]:
    latest_date = max(row["date"] for row in daily)
    latest = [row for row in daily if row["date"] == latest_date]
    action_counts: dict[str, int] = defaultdict(int)
    guardrail_counts: dict[str, int] = defaultdict(int)
    for row in recommendations:
        action_counts[row["recommended_action"]] += 1
        guardrail_counts[row["business_constraints_status"]] += 1
    return {
        "period_start": START_DATE.isoformat(),
        "latest_date": latest_date.isoformat(),
        "daily_rows": len(daily),
        "latest_campaigns": len(latest),
        "latest_with_budget": sum(row["budget"] > 0 for row in latest),
        "latest_with_target_roas": sum(row["target_roas"] > 0 for row in latest),
        "latest_with_target_cpa": sum(row["target_cpa"] > 0 for row in latest),
        "intraday_rows": len(intraday),
        "intraday_campaigns": len({row["campaign_id"] for row in intraday}),
        "action_counts": dict(action_counts),
        "guardrail_counts": dict(guardrail_counts),
        "outputs": {
            "daily_metrics": str(OUTPUT_DIR / "apice_daily_metrics_2026.csv"),
            "intraday_forecast": str(OUTPUT_DIR / "apice_intraday_forecast.csv"),
            "campaign_features": str(OUTPUT_DIR / "apice_campaign_features.csv"),
            "final_recommendations": str(OUTPUT_DIR / "apice_final_recommendations.csv"),
        },
    }


def normalize_daily(row: dict[str, str]) -> dict[str, Any]:
    return {
        **row,
        "date": parse_date(row["date"]),
        "campaign_id": str(row["campaign_id"]),
        "cost": number(row.get("cost")),
        "impressions": number(row.get("impressions")),
        "clicks": number(row.get("clicks")),
        "conversions": number(row.get("conversions")),
        "conversion_value": number(row.get("conversion_value")),
        "ads_conversion_value": number(row.get("ads_conversion_value") or row.get("conversion_value")),
        "ga4_purchase_revenue": number(row.get("ga4_purchase_revenue")),
        "business_revenue": number(row.get("business_revenue") or row.get("ga4_purchase_revenue")),
        "ga4_transactions": number(row.get("ga4_transactions")),
        "ga4_sessions": number(row.get("ga4_sessions")),
        "budget": number(row.get("budget")),
        "target_roas": number(row.get("target_roas")),
        "target_cpa": number(row.get("target_cpa")),
        "impression_share": number(row.get("impression_share")),
        "lost_is_budget": number(row.get("lost_is_budget")),
        "lost_is_rank": number(row.get("lost_is_rank")),
        "ctr": number(row.get("ctr")),
        "cpc": number(row.get("cpc")),
        "cvr": number(row.get("cvr")),
        "roas": number(row.get("roas")),
        "ads_roas": number(row.get("ads_roas") or row.get("roas")),
        "ga4_roas": number(row.get("ga4_roas") or row.get("roas")),
    }


def normalize_hourly(row: dict[str, str]) -> dict[str, Any]:
    return {
        **row,
        "date": parse_date(row["date"]),
        "campaign_id": str(row["campaign_id"]),
        "status": row.get("campaign_status") or row.get("status") or "UNKNOWN",
        "hour": int(float(row["hour"])),
        "cost": number(row.get("cost_brl")),
        "impressions": number(row.get("impressions")),
        "clicks": number(row.get("clicks")),
        "conversions": number(row.get("conversions")),
        "conversion_value": number(row.get("conversion_value")),
        "budget": number(row.get("budget")),
        "target_roas": number(row.get("target_roas")),
        "target_cpa": number(row.get("target_cpa")),
    }


def trend_status(row: dict[str, Any], roas_28d: float, cpa_28d: float) -> str:
    if row["target_roas"]:
        if row["ads_roas"] >= row["target_roas"] * 1.15:
            return "above_real_target"
        if row["ads_roas"] < row["target_roas"] * 0.80:
            return "below_real_target"
        return "near_real_target"
    if row["target_cpa"] and row["conversions"]:
        current_cpa = safe_div(row["cost"], row["conversions"])
        if current_cpa <= row["target_cpa"]:
            return "above_real_target"
        return "below_real_target"
    if roas_28d:
        if row["roas"] > roas_28d * 1.20:
            return "positive_vs_history"
        if row["roas"] < roas_28d * 0.80:
            return "negative_vs_history"
    return "normal"


def business_trend_status(row: dict[str, Any], roas_28d: float) -> str:
    if row["target_roas"]:
        if row["ga4_roas"] >= row["target_roas"] * 1.15:
            return "business_above_target_reference"
        if row["ga4_roas"] < row["target_roas"] * 0.80:
            return "business_below_target_reference"
        return "business_near_target_reference"
    if roas_28d:
        if row["ga4_roas"] > roas_28d * 1.20:
            return "business_positive_vs_history"
        if row["ga4_roas"] < roas_28d * 0.80:
            return "business_negative_vs_history"
    return "business_normal"


def data_sufficiency(rows: list[dict[str, Any]]) -> str:
    cost_28d = sum(row["cost"] for row in rows)
    clicks_28d = sum(row["clicks"] for row in rows)
    conversion_days = sum(1 for row in rows if row["conversions"] > 0)
    if cost_28d >= 1000 and clicks_28d >= 300 and conversion_days >= 7:
        return "high"
    if cost_28d >= 300 and clicks_28d >= 100:
        return "medium"
    if cost_28d > 0:
        return "low"
    return "insufficient"


def roas(rows: list[dict[str, Any]], value_key: str = "business_revenue") -> float:
    return safe_div(sum(row[value_key] for row in rows), sum(row["cost"] for row in rows))


def cpa(rows: list[dict[str, Any]]) -> float:
    return safe_div(sum(row["cost"] for row in rows), sum(row["conversions"] for row in rows))


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


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


if __name__ == "__main__":
    main()
