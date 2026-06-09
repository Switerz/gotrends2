"""Build local staging datasets by joining Metabase daily data with Google Ads API CSVs."""

from __future__ import annotations

import csv
import json
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "outputs" / "apice_google_ads"
LOCAL_STAGING_DIR = ROOT / "outputs" / "local_staging"
COMPANY = "Apice"


def main() -> None:
    LOCAL_STAGING_DIR.mkdir(parents=True, exist_ok=True)

    settings = read_csv(API_DIR / "apice_campaign_settings.csv")
    hourly = read_csv(API_DIR / "apice_hourly_metrics.csv")
    daily = fetch_apice_daily_from_metabase()

    settings_by_campaign = {str(row["campaign_id"]): row for row in settings}
    daily_enriched = enrich_daily(daily, settings_by_campaign)
    hourly_enriched = enrich_hourly(hourly, settings_by_campaign)

    write_csv(LOCAL_STAGING_DIR / "apice_campaign_daily_enriched.csv", daily_enriched)
    write_csv(LOCAL_STAGING_DIR / "apice_campaign_hourly_metrics.csv", hourly_enriched)

    summary = build_summary(settings, hourly_enriched, daily_enriched)
    (LOCAL_STAGING_DIR / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


def fetch_apice_daily_from_metabase() -> list[dict[str, Any]]:
    bounds_payload = execute_metabase(
        """
        SELECT
          MIN(date) AS min_date,
          MAX(date) AS max_date
        FROM raw.gogroup_google_ads
        WHERE LOWER(company) = 'apice'
        """
    )
    bounds = bounds_payload.get("data", {}).get("rows", [[]])[0]
    min_date = parse_date(bounds[0])
    max_date = parse_date(bounds[1])
    rows: list[dict[str, Any]] = []
    current = date(min_date.year, min_date.month, 1)
    while current <= max_date:
        next_month = month_after(current)
        rows.extend(fetch_apice_daily_window(current, next_month))
        current = next_month
    return rows


def fetch_apice_daily_window(start_date: date, end_date: date) -> list[dict[str, Any]]:
    sql = f"""
    WITH ad_daily AS (
      SELECT
        ads.date,
        ads.company,
        ads.campaign_id,
        MAX(ads.campaign_name) AS campaign_name,
        MAX(ads.channel_type) AS campaign_type,
        SUM(ads.cost)::numeric AS cost,
        SUM(ads.impressions)::bigint AS impressions,
        SUM(ads.clicks)::bigint AS clicks,
        SUM(ads.conversions)::numeric AS conversions,
        SUM(ads.revenue)::numeric AS ads_conversion_value
      FROM raw.gogroup_google_ads AS ads
      WHERE LOWER(ads.company) = 'apice'
        AND ads.date >= DATE '{start_date.isoformat()}'
        AND ads.date < DATE '{end_date.isoformat()}'
      GROUP BY 1, 2, 3
    ),
    ga4_daily AS (
      SELECT
        ga4.date::date AS date,
        ga4.company,
        LOWER(TRIM(ga4.campaign)) AS campaign_key,
        SUM(ga4.purchase_revenue)::numeric AS ga4_purchase_revenue,
        SUM(ga4.transactions)::numeric AS ga4_transactions,
        SUM(ga4.sessions)::bigint AS ga4_sessions
      FROM raw.ga4_gogroup_all_channels AS ga4
      WHERE LOWER(ga4.company) = 'apice'
        AND ga4.date >= DATE '{start_date.isoformat()}'
        AND ga4.date < DATE '{end_date.isoformat()}'
        AND LOWER(ga4.source) = 'google'
        AND LOWER(ga4.medium) = 'cpc'
      GROUP BY 1, 2, 3
    ),
    attrs AS (
      SELECT
        campaigns.date,
        campaigns.company,
        campaigns.campaign_id,
        campaigns.search_impression_share::numeric AS impression_share,
        campaigns.search_budget_lost_impression_share::numeric AS lost_is_budget,
        campaigns.search_rank_lost_impression_share::numeric AS lost_is_rank
      FROM raw.gogroup_google_ads_campaigns AS campaigns
      WHERE LOWER(campaigns.company) = 'apice'
        AND campaigns.date >= DATE '{start_date.isoformat()}'
        AND campaigns.date < DATE '{end_date.isoformat()}'
    )
    SELECT
      ad_daily.date,
      ad_daily.company,
      ad_daily.campaign_id,
      ad_daily.campaign_name,
      ad_daily.campaign_type,
      ad_daily.cost,
      ad_daily.impressions,
      ad_daily.clicks,
      ad_daily.conversions,
      ad_daily.ads_conversion_value AS conversion_value,
      ad_daily.ads_conversion_value,
      COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric AS ga4_purchase_revenue,
      COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric AS business_revenue,
      COALESCE(ga4_daily.ga4_transactions, 0)::numeric AS ga4_transactions,
      COALESCE(ga4_daily.ga4_sessions, 0)::bigint AS ga4_sessions,
      CASE WHEN ga4_daily.campaign_key IS NULL THEN 'missing' ELSE 'ga4_google_cpc_campaign_name' END AS ga4_revenue_source,
      attrs.impression_share,
      attrs.lost_is_budget,
      attrs.lost_is_rank,
      ad_daily.clicks::numeric / NULLIF(ad_daily.impressions, 0) AS ctr,
      ad_daily.cost / NULLIF(ad_daily.clicks, 0) AS cpc,
      ad_daily.conversions / NULLIF(ad_daily.clicks, 0) AS cvr,
      ad_daily.ads_conversion_value / NULLIF(ad_daily.cost, 0) AS ads_roas,
      COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric / NULLIF(ad_daily.cost, 0) AS ga4_roas,
      COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric / NULLIF(ad_daily.cost, 0) AS roas
    FROM ad_daily
    LEFT JOIN ga4_daily
      ON ga4_daily.date = ad_daily.date
      AND ga4_daily.company = ad_daily.company
      AND ga4_daily.campaign_key = LOWER(TRIM(ad_daily.campaign_name))
    LEFT JOIN attrs
      ON attrs.date = ad_daily.date
      AND attrs.company = ad_daily.company
      AND attrs.campaign_id = ad_daily.campaign_id
    ORDER BY ad_daily.date, ad_daily.campaign_id
    """
    payload = execute_metabase(sql)
    cols = [col["name"] for col in payload.get("data", {}).get("cols", [])]
    return [dict(zip(cols, row)) for row in payload.get("data", {}).get("rows", [])]


def parse_date(value: str) -> date:
    return date.fromisoformat(value[:10])


def month_after(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def enrich_daily(
    daily: list[dict[str, Any]],
    settings_by_campaign: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    enriched = []
    for row in daily:
        campaign_id = str(row["campaign_id"])
        setting = settings_by_campaign.get(campaign_id, {})
        budget = number(setting.get("budget_brl"))
        target_roas = number(setting.get("target_roas"))
        target_cpa = number(setting.get("target_cpa_brl"))
        cost = number(row.get("cost"))
        enriched.append(
            {
                **row,
                "status": setting.get("campaign_status") or "UNKNOWN",
                "bidding_strategy": setting.get("bidding_strategy_type") or "",
                "budget": budget or "",
                "target_roas": target_roas or "",
                "target_cpa": target_cpa or "",
                "budget_consumption": cost / budget if budget else "",
                "settings_source": "google_ads_api" if setting else "missing",
            }
        )
    return enriched


def enrich_hourly(
    hourly: list[dict[str, str]],
    settings_by_campaign: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    enriched = []
    for row in hourly:
        campaign_id = str(row["campaign_id"])
        setting = settings_by_campaign.get(campaign_id, {})
        budget = number(setting.get("budget_brl"))
        target_roas = number(setting.get("target_roas"))
        target_cpa = number(setting.get("target_cpa_brl"))
        cost = number(row.get("cost_brl"))
        impressions = number(row.get("impressions"))
        clicks = number(row.get("clicks"))
        conversions = number(row.get("conversions"))
        conversion_value = number(row.get("conversion_value"))
        enriched.append(
            {
                **row,
                "bidding_strategy": setting.get("bidding_strategy_type") or "",
                "budget": budget or "",
                "target_roas": target_roas or "",
                "target_cpa": target_cpa or "",
                "budget_consumption": cost / budget if budget else "",
                "ctr": clicks / impressions if impressions else "",
                "cpc": cost / clicks if clicks else "",
                "cvr": conversions / clicks if clicks else "",
                "roas": conversion_value / cost if cost else "",
                "settings_source": "google_ads_api" if setting else "missing",
            }
        )
    return enriched


def build_summary(
    settings: list[dict[str, str]],
    hourly: list[dict[str, Any]],
    daily: list[dict[str, Any]],
) -> dict[str, Any]:
    latest_daily_date = max(row["date"] for row in daily) if daily else None
    latest_daily = [row for row in daily if row["date"] == latest_daily_date]
    latest_hourly_date = max(row["date"] for row in hourly) if hourly else None
    latest_hourly = [row for row in hourly if row["date"] == latest_hourly_date]
    return {
        "settings_rows": len(settings),
        "settings_status": dict(Counter(row["campaign_status"] for row in settings)),
        "daily_rows": len(daily),
        "daily_campaigns": len({row["campaign_id"] for row in daily}),
        "daily_with_budget": count_present(daily, "budget"),
        "daily_with_target_roas": count_present(daily, "target_roas"),
        "daily_with_target_cpa": count_present(daily, "target_cpa"),
        "daily_with_ga4_revenue_match": sum(
            row.get("ga4_revenue_source") == "ga4_google_cpc_campaign_name" for row in daily
        ),
        "latest_daily_date": latest_daily_date,
        "latest_daily_campaigns": len({row["campaign_id"] for row in latest_daily}),
        "latest_daily_with_budget": count_present(latest_daily, "budget"),
        "latest_daily_with_any_target": sum(
            bool(row.get("target_roas") or row.get("target_cpa")) for row in latest_daily
        ),
        "latest_daily_with_ga4_revenue_match": sum(
            row.get("ga4_revenue_source") == "ga4_google_cpc_campaign_name"
            for row in latest_daily
        ),
        "hourly_rows": len(hourly),
        "hourly_campaigns": len({row["campaign_id"] for row in hourly}),
        "hourly_with_budget": count_present(hourly, "budget"),
        "latest_hourly_date": latest_hourly_date,
        "latest_hourly_rows": len(latest_hourly),
        "latest_hourly_campaigns": len({row["campaign_id"] for row in latest_hourly}),
        "latest_hourly_hours": sorted({int(row["hour"]) for row in latest_hourly}),
        "outputs": {
            "daily": str(LOCAL_STAGING_DIR / "apice_campaign_daily_enriched.csv"),
            "hourly": str(LOCAL_STAGING_DIR / "apice_campaign_hourly_metrics.csv"),
            "summary": str(LOCAL_STAGING_DIR / "summary.json"),
        },
    }


def count_present(rows: list[dict[str, Any]], key: str) -> int:
    return sum(bool(row.get(key) not in ("", None, 0, 0.0)) for row in rows)


def execute_metabase(sql: str) -> dict:
    cfg = json.loads((ROOT / ".mcp.json").read_text())
    server = cfg["mcpServers"]["metabase"]
    url = server["env"]["METABASE_URL"].rstrip("/") + "/api/dataset"
    key = server["env"]["METABASE_API_KEY"]
    body = json.dumps(
        {"database": 63, "type": "native", "native": {"query": sql}}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("error"):
        raise RuntimeError(payload["error"])
    return payload


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


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


if __name__ == "__main__":
    main()
