"""Export recent Google Ads change history for Apice."""

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


CHANGE_FIELDS = [
    "change_event.change_date_time",
    "change_event.change_resource_name",
    "change_event.change_resource_type",
    "change_event.client_type",
    "change_event.resource_change_operation",
    "change_event.campaign",
    "change_event.ad_group",
]


def main() -> None:
    args = parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with GoogleAdsMcpClient(
        login_customer_id=args.login_customer_id,
        config_path=Path(args.config_path),
        timeout_seconds=120,
    ) as client:
        rows = client.search(
            customer_id=args.customer_id,
            resource="change_event",
            fields=CHANGE_FIELDS,
            conditions=[
                f"change_event.change_date_time >= '{args.start_datetime}'",
                f"change_event.change_date_time <= '{args.end_datetime}'",
            ],
            orderings=["change_event.change_date_time DESC"],
            limit=args.limit,
        )
    normalized = [normalize_change(row) for row in rows]
    output = OUTPUT_DIR / "apice_change_history.csv"
    write_csv(output, normalized)
    summary = {
        "rows": len(normalized),
        "output": str(output),
        "start_datetime": args.start_datetime,
        "end_datetime": args.end_datetime,
    }
    (OUTPUT_DIR / "apice_change_history_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--customer-id", default=APICE_CUSTOMER_ID)
    parser.add_argument("--login-customer-id", default=DEFAULT_LOGIN_CUSTOMER_ID)
    parser.add_argument("--config-path", default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--start-datetime", default="2026-01-01 00:00:00")
    parser.add_argument(
        "--end-datetime",
        default=f"{date.today().isoformat()} 23:59:59",
    )
    parser.add_argument("--limit", type=int, default=5000)
    return parser.parse_args()


def normalize_change(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "change_date_time": row.get("change_event.change_date_time"),
        "change_resource_name": row.get("change_event.change_resource_name"),
        "change_resource_type": row.get("change_event.change_resource_type"),
        "client_type": row.get("change_event.client_type"),
        "user_email": "",
        "resource_change_operation": row.get("change_event.resource_change_operation"),
        "campaign_resource": row.get("change_event.campaign"),
        "ad_group_resource": row.get("change_event.ad_group"),
        "changed_fields": "",
    }


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
