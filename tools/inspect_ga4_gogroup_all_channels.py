"""Inspect GA4 all-channels fields needed for Apice ROAS integration."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    queries = [
        (
            "columns",
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'raw'
              AND table_name = 'ga4_gogroup_all_channels'
            ORDER BY ordinal_position
            """,
        ),
        (
            "sample",
            """
            SELECT *
            FROM raw.ga4_gogroup_all_channels
            WHERE LOWER(company) = 'apice'
              AND date >= DATE '2026-01-01'
            LIMIT 3
            """,
        ),
        (
            "google_cpc_summary",
            """
            SELECT
              COUNT(*) AS rows,
              MIN(date) AS min_date,
              MAX(date) AS max_date,
              COUNT(DISTINCT campaign) AS campaigns,
              SUM(purchase_revenue)::numeric AS purchase_revenue,
              SUM(transactions)::numeric AS transactions,
              SUM(sessions)::numeric AS sessions
            FROM raw.ga4_gogroup_all_channels
            WHERE LOWER(company) = 'apice'
              AND date >= DATE '2026-01-01'
              AND LOWER(source) = 'google'
              AND LOWER(medium) = 'cpc'
            """,
        ),
        (
            "top_google_cpc_campaigns",
            """
            SELECT
              campaign,
              SUM(purchase_revenue)::numeric AS purchase_revenue,
              SUM(transactions)::numeric AS transactions,
              SUM(sessions)::numeric AS sessions
            FROM raw.ga4_gogroup_all_channels
            WHERE LOWER(company) = 'apice'
              AND date >= DATE '2026-01-01'
              AND LOWER(source) = 'google'
              AND LOWER(medium) = 'cpc'
            GROUP BY campaign
            ORDER BY purchase_revenue DESC NULLS LAST
            LIMIT 25
            """,
        ),
    ]
    for name, sql in queries:
        payload = execute_metabase(sql)
        print(f"--- {name}")
        print([col["name"] for col in payload.get("data", {}).get("cols", [])])
        for row in payload.get("data", {}).get("rows", [])[:20]:
            print(row)


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
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("error"):
        raise RuntimeError(payload["error"])
    return payload


if __name__ == "__main__":
    main()
