"""Validate Apice models with Google Ads API settings/hourly CSVs instead of proxies."""

from __future__ import annotations

import csv
import json
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "outputs" / "apice_google_ads"


def main() -> None:
    settings = read_csv(OUTPUT_DIR / "apice_campaign_settings.csv")
    hourly = read_csv(OUTPUT_DIR / "apice_hourly_metrics.csv")
    daily = latest_daily_apice()

    settings_by_campaign = {str(row["campaign_id"]): row for row in settings}
    enriched = []
    for row in daily:
        campaign_id = str(row["campaign_id"])
        setting = settings_by_campaign.get(campaign_id, {})
        cost = number(row.get("cost"))
        budget = number(setting.get("budget_brl"))
        target_roas = number(setting.get("target_roas"))
        target_cpa = number(setting.get("target_cpa_brl"))
        roas = number(row.get("roas"))
        enriched.append(
            {
                **row,
                "budget_brl": budget,
                "target_roas": target_roas,
                "target_cpa_brl": target_cpa,
                "budget_consumption": cost / budget if budget else None,
                "target_source": "google_ads_api" if target_roas or target_cpa else "missing",
                "roas_vs_target": roas / target_roas if target_roas else None,
            }
        )

    latest_hourly_date = max(row["date"] for row in hourly)
    latest_hourly = [row for row in hourly if row["date"] == latest_hourly_date]

    print(
        json.dumps(
            {
                "daily_campaigns": len(enriched),
                "daily_with_budget": sum(row["budget_brl"] > 0 for row in enriched),
                "daily_with_target_roas": sum(row["target_roas"] > 0 for row in enriched),
                "daily_with_target_cpa": sum(row["target_cpa_brl"] > 0 for row in enriched),
                "daily_without_any_target": sum(row["target_source"] == "missing" for row in enriched),
                "latest_hourly_date": latest_hourly_date,
                "latest_hourly_rows": len(latest_hourly),
                "latest_hourly_campaigns": len({row["campaign_id"] for row in latest_hourly}),
                "latest_hourly_hours": sorted({int(row["hour"]) for row in latest_hourly}),
                "latest_hourly_cost_brl": round(sum(number(row["cost_brl"]) for row in latest_hourly), 2),
                "latest_hourly_conversion_value": round(
                    sum(number(row["conversion_value"]) for row in latest_hourly), 2
                ),
                "enabled_settings": dict(Counter(row["campaign_status"] for row in settings)),
            },
            indent=2,
        )
    )


def latest_daily_apice() -> list[dict[str, Any]]:
    sql = """
    WITH daily AS (
      SELECT
        date,
        company,
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        SUM(cost)::numeric AS cost,
        SUM(revenue)::numeric AS conversion_value,
        SUM(revenue)::numeric / NULLIF(SUM(cost)::numeric, 0) AS roas
      FROM raw.gogroup_google_ads
      WHERE LOWER(company) = 'apice'
      GROUP BY 1, 2, 3
    )
    SELECT
      date,
      company,
      campaign_id,
      campaign_name,
      cost,
      conversion_value,
      roas
    FROM daily
    WHERE date = (SELECT MAX(date) FROM daily)
    ORDER BY cost DESC
    """
    payload = execute(sql)
    cols = [col["name"] for col in payload.get("data", {}).get("cols", [])]
    return [dict(zip(cols, row)) for row in payload.get("data", {}).get("rows", [])]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def execute(sql: str) -> dict:
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
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("error"):
        raise RuntimeError(payload["error"])
    return payload


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


if __name__ == "__main__":
    main()
