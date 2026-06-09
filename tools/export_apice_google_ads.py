"""Export Apice Google Ads settings and hourly metrics for GoTrends staging."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import date
from pathlib import Path
from typing import Any

from google_ads_mcp_client import GoogleAdsMcpClient


APICE_CUSTOMER_ID = "7705857660"
DEFAULT_LOGIN_CUSTOMER_ID = "8967361488"
DEFAULT_CONFIG_PATH = "C:/Users/Notebook/google-ads.yaml"
OUTPUT_DIR = Path("outputs/apice_google_ads")


SETTINGS_FIELDS = [
    "customer.id",
    "campaign.id",
    "campaign.name",
    "campaign.status",
    "campaign.bidding_strategy_type",
    "campaign.campaign_budget",
    "campaign.target_roas.target_roas",
    "campaign.maximize_conversion_value.target_roas",
    "campaign.target_cpa.target_cpa_micros",
    "campaign.maximize_conversions.target_cpa_micros",
    "campaign_budget.amount_micros",
    "campaign_budget.total_amount_micros",
    "campaign_budget.period",
    "campaign_budget.status",
]

HOURLY_FIELDS = [
    "customer.id",
    "campaign.id",
    "campaign.name",
    "campaign.status",
    "segments.date",
    "segments.hour",
    "metrics.cost_micros",
    "metrics.impressions",
    "metrics.clicks",
    "metrics.conversions",
    "metrics.conversions_value",
]


def main() -> None:
    args = parse_args()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with GoogleAdsMcpClient(
        login_customer_id=args.login_customer_id,
        config_path=Path(args.config_path),
    ) as client:
        settings_rows = export_settings(client, args.customer_id, out_dir, args.settings_limit)
        hourly_rows = export_hourly(
            client,
            args.customer_id,
            out_dir,
            args.date_condition,
            args.hourly_limit,
        )

    summary = {
        "customer_id": args.customer_id,
        "settings_rows": len(settings_rows),
        "hourly_rows": len(hourly_rows),
        "settings_output": str(out_dir / "apice_campaign_settings.csv"),
        "hourly_output": str(out_dir / "apice_hourly_metrics.csv"),
        "run_date": date.today().isoformat(),
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--customer-id", default=APICE_CUSTOMER_ID)
    parser.add_argument("--login-customer-id", default=DEFAULT_LOGIN_CUSTOMER_ID)
    parser.add_argument("--config-path", default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    parser.add_argument("--date-condition", default="segments.date DURING LAST_7_DAYS")
    parser.add_argument("--settings-limit", type=int, default=1000)
    parser.add_argument("--hourly-limit", type=int, default=5000)
    return parser.parse_args()


def export_settings(
    client: GoogleAdsMcpClient,
    customer_id: str,
    out_dir: Path,
    limit: int,
) -> list[dict[str, Any]]:
    rows = client.search(
        customer_id=customer_id,
        resource="campaign",
        fields=SETTINGS_FIELDS,
        conditions=["campaign.status != REMOVED"],
        orderings=["campaign.status", "campaign.name"],
        limit=limit,
    )
    normalized = [normalize_settings_row(row) for row in rows]
    write_csv(out_dir / "apice_campaign_settings.csv", normalized)
    return normalized


def export_hourly(
    client: GoogleAdsMcpClient,
    customer_id: str,
    out_dir: Path,
    date_condition: str,
    limit: int,
) -> list[dict[str, Any]]:
    rows = client.search(
        customer_id=customer_id,
        resource="campaign",
        fields=HOURLY_FIELDS,
        conditions=[date_condition, "campaign.status != REMOVED"],
        orderings=["segments.date DESC", "segments.hour DESC", "campaign.name"],
        limit=limit,
    )
    normalized = [normalize_hourly_row(row) for row in rows]
    write_csv(out_dir / "apice_hourly_metrics.csv", normalized)
    return normalized


def normalize_settings_row(row: dict[str, Any]) -> dict[str, Any]:
    target_roas = first_number(
        row,
        "campaign.target_roas.target_roas",
        "campaign.maximize_conversion_value.target_roas",
    )
    target_cpa_micros = first_number(
        row,
        "campaign.target_cpa.target_cpa_micros",
        "campaign.maximize_conversions.target_cpa_micros",
    )
    budget_micros = first_number(
        row,
        "campaign_budget.amount_micros",
        "campaign_budget.total_amount_micros",
    )
    return {
        "customer_id": row.get("customer.id"),
        "company": "Apice",
        "campaign_id": row.get("campaign.id"),
        "campaign_name": row.get("campaign.name"),
        "campaign_status": row.get("campaign.status"),
        "bidding_strategy_type": row.get("campaign.bidding_strategy_type"),
        "campaign_budget_resource": row.get("campaign.campaign_budget"),
        "budget_amount_micros": int(budget_micros or 0),
        "budget_brl": micros_to_currency(budget_micros),
        "budget_period": row.get("campaign_budget.period"),
        "budget_status": row.get("campaign_budget.status"),
        "target_roas": target_roas or 0,
        "target_cpa_micros": int(target_cpa_micros or 0),
        "target_cpa_brl": micros_to_currency(target_cpa_micros),
    }


def normalize_hourly_row(row: dict[str, Any]) -> dict[str, Any]:
    cost_micros = first_number(row, "metrics.cost_micros")
    return {
        "customer_id": row.get("customer.id"),
        "company": "Apice",
        "campaign_id": row.get("campaign.id"),
        "campaign_name": row.get("campaign.name"),
        "campaign_status": row.get("campaign.status"),
        "date": row.get("segments.date"),
        "hour": row.get("segments.hour"),
        "cost_micros": int(cost_micros or 0),
        "cost_brl": micros_to_currency(cost_micros),
        "impressions": row.get("metrics.impressions") or 0,
        "clicks": row.get("metrics.clicks") or 0,
        "conversions": row.get("metrics.conversions") or 0,
        "conversion_value": row.get("metrics.conversions_value") or 0,
    }


def first_number(row: dict[str, Any], *keys: str) -> float:
    for key in keys:
        try:
            value = float(row.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value:
            return value
    return 0


def micros_to_currency(value: float) -> float:
    return round((value or 0) / 1_000_000, 2)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
