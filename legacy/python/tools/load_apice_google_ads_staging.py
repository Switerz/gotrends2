"""Load Apice Google Ads API exports into Data Mart staging tables."""

from __future__ import annotations

import csv
import json
import urllib.request
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "outputs" / "apice_google_ads"
CUSTOMER_ID = "7705857660"


SETTINGS_TABLE = "staging.google_ads_campaign_settings"
HOURLY_TABLE = "staging.google_ads_hourly_metrics"


def main() -> None:
    settings = read_csv(OUTPUT_DIR / "apice_campaign_settings.csv")
    hourly = read_csv(OUTPUT_DIR / "apice_hourly_metrics.csv")

    if not settings:
        raise RuntimeError("No campaign settings rows found. Run export_apice_google_ads.py first.")
    if not hourly:
        raise RuntimeError("No hourly metric rows found. Run export_apice_google_ads.py first.")

    execute("CREATE SCHEMA IF NOT EXISTS staging")
    execute(create_settings_table_sql())
    execute(create_hourly_table_sql())

    execute(f"DELETE FROM {SETTINGS_TABLE} WHERE customer_id = {sql_string(CUSTOMER_ID)}")
    execute(f"DELETE FROM {HOURLY_TABLE} WHERE customer_id = {sql_string(CUSTOMER_ID)}")

    insert_rows(SETTINGS_TABLE, settings, settings_columns(), chunk_size=100)
    insert_rows(HOURLY_TABLE, hourly, hourly_columns(), chunk_size=250)

    validation = execute(
        f"""
        SELECT 'settings' AS table_name, COUNT(*) AS rows
        FROM {SETTINGS_TABLE}
        WHERE customer_id = {sql_string(CUSTOMER_ID)}
        UNION ALL
        SELECT 'hourly' AS table_name, COUNT(*) AS rows
        FROM {HOURLY_TABLE}
        WHERE customer_id = {sql_string(CUSTOMER_ID)}
        """
    )
    print(json.dumps(validation.get("data", {}).get("rows", []), indent=2))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def execute(sql: str) -> dict:
    url, key = metabase_config()
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


def metabase_config() -> tuple[str, str]:
    cfg = json.loads((ROOT / ".mcp.json").read_text())
    server = cfg["mcpServers"]["metabase"]
    return server["env"]["METABASE_URL"].rstrip("/") + "/api/dataset", server["env"]["METABASE_API_KEY"]


def insert_rows(
    table: str,
    rows: list[dict[str, str]],
    columns: list[tuple[str, str]],
    chunk_size: int,
) -> None:
    names = [name for name, _kind in columns]
    for start in range(0, len(rows), chunk_size):
        chunk = rows[start : start + chunk_size]
        values = []
        for row in chunk:
            values.append(
                "("
                + ", ".join(sql_value(row.get(name, ""), kind) for name, kind in columns)
                + ")"
            )
        sql = f"""
        INSERT INTO {table} ({", ".join(names)})
        VALUES
        {", ".join(values)}
        """
        execute(sql)


def sql_value(value: str | None, kind: str) -> str:
    if value is None or value == "":
        return "NULL"
    if kind == "text":
        return sql_string(value)
    if kind == "int":
        return str(int(float(value)))
    if kind == "numeric":
        return str(float(value))
    if kind == "date":
        return sql_string(value)
    raise ValueError(f"Unknown SQL value kind: {kind}")


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def settings_columns() -> list[tuple[str, str]]:
    return [
        ("customer_id", "text"),
        ("company", "text"),
        ("campaign_id", "int"),
        ("campaign_name", "text"),
        ("campaign_status", "text"),
        ("bidding_strategy_type", "text"),
        ("campaign_budget_resource", "text"),
        ("budget_amount_micros", "int"),
        ("budget_brl", "numeric"),
        ("budget_period", "text"),
        ("budget_status", "text"),
        ("target_roas", "numeric"),
        ("target_cpa_micros", "int"),
        ("target_cpa_brl", "numeric"),
    ]


def hourly_columns() -> list[tuple[str, str]]:
    return [
        ("customer_id", "text"),
        ("company", "text"),
        ("campaign_id", "int"),
        ("campaign_name", "text"),
        ("campaign_status", "text"),
        ("date", "date"),
        ("hour", "int"),
        ("cost_micros", "int"),
        ("cost_brl", "numeric"),
        ("impressions", "int"),
        ("clicks", "int"),
        ("conversions", "numeric"),
        ("conversion_value", "numeric"),
    ]


def create_settings_table_sql() -> str:
    return f"""
    CREATE TABLE IF NOT EXISTS {SETTINGS_TABLE} (
      customer_id text NOT NULL,
      company text NOT NULL,
      campaign_id bigint NOT NULL,
      campaign_name text,
      campaign_status text,
      bidding_strategy_type text,
      campaign_budget_resource text,
      budget_amount_micros bigint,
      budget_brl numeric,
      budget_period text,
      budget_status text,
      target_roas numeric,
      target_cpa_micros bigint,
      target_cpa_brl numeric,
      loaded_at timestamp without time zone DEFAULT now()
    )
    """


def create_hourly_table_sql() -> str:
    return f"""
    CREATE TABLE IF NOT EXISTS {HOURLY_TABLE} (
      customer_id text NOT NULL,
      company text NOT NULL,
      campaign_id bigint NOT NULL,
      campaign_name text,
      campaign_status text,
      date date NOT NULL,
      hour integer NOT NULL,
      cost_micros bigint,
      cost_brl numeric,
      impressions bigint,
      clicks bigint,
      conversions numeric,
      conversion_value numeric,
      loaded_at timestamp without time zone DEFAULT now()
    )
    """


if __name__ == "__main__":
    main()
