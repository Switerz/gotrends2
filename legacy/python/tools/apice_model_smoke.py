"""Smoke-test GoTrends SQL models for the Apice account."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPANY = "apice"


def metabase_config() -> tuple[str, str]:
    cfg = json.loads((ROOT / ".mcp.json").read_text())
    server = cfg["mcpServers"]["metabase"]
    return server["env"]["METABASE_URL"].rstrip("/") + "/api/dataset", server["env"]["METABASE_API_KEY"]


def query_file(path: str) -> str:
    sql = (ROOT / path).read_text().strip()
    sql = sql.replace(";\r\n", "\r\n").replace(";\n", "\n")
    if sql.endswith(";"):
        sql = sql[:-1]
    return sql


def run_metabase(sql: str) -> dict:
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
    with urllib.request.urlopen(req, timeout=240) as resp:
        return json.loads(resp.read().decode("utf-8"))


def print_rows(name: str, payload: dict) -> None:
    print(f"\nTASK {name}")
    if payload.get("error"):
        print("ERROR", payload["error"])
        return
    cols = [col.get("name") for col in payload.get("data", {}).get("cols", [])]
    for row in payload.get("data", {}).get("rows", []):
        print(dict(zip(cols, row)))


def wrap(path: str, select_sql: str) -> str:
    return (
        select_sql.replace("{q}", query_file(path) + "\n").replace("{company}", COMPANY)
    )


def main() -> None:
    tasks = [
        (
            "01_daily",
            "queries/01_campaign_daily_metrics.sql",
            "SELECT COUNT(*) AS rows, MIN(date) AS min_date, MAX(date) AS max_date, "
            "COUNT(DISTINCT campaign_id) AS campaigns "
            "FROM ({q}) AS x WHERE LOWER(company) = '{company}'",
        ),
        (
            "05_trend_dist",
            "queries/05_baseline_trend.sql",
            "SELECT trend_status, COUNT(*) AS rows FROM ({q}) AS x "
            "WHERE LOWER(company) = '{company}' GROUP BY 1 ORDER BY rows DESC",
        ),
        (
            "06_confidence_dist",
            "queries/06_confidence_features.sql",
            "SELECT data_sufficiency, COUNT(*) AS rows FROM ({q}) AS x "
            "WHERE LOWER(company) = '{company}' GROUP BY 1 ORDER BY rows DESC",
        ),
        (
            "07_spend_bands",
            "queries/07_spend_bands.sql",
            "SELECT model_level, COUNT(*) AS rows, "
            "COUNT(*) FILTER (WHERE marginal_roas IS NOT NULL) AS with_marginal_roas "
            "FROM ({q}) AS x WHERE LOWER(company) = '{company}' "
            "GROUP BY 1 ORDER BY rows DESC",
        ),
        (
            "08_marginal_summary",
            "queries/08_marginal_roas.sql",
            "SELECT COUNT(*) AS rows, COUNT(DISTINCT campaign_id) AS campaigns, "
            "COUNT(*) FILTER (WHERE marginal_roas IS NOT NULL) AS with_marginal_roas, "
            "COUNT(*) FILTER (WHERE elasticity IS NOT NULL) AS with_elasticity "
            "FROM ({q}) AS x WHERE LOWER(company) = '{company}'",
        ),
        (
            "09_saturation_dist",
            "queries/09_saturation_features.sql",
            "SELECT saturation_level, COUNT(*) AS rows FROM ({q}) AS x "
            "WHERE LOWER(company) = '{company}' GROUP BY 1 ORDER BY rows DESC",
        ),
        (
            "10_action_dist",
            "queries/10_campaign_decision_features.sql",
            "SELECT recommended_action, risk_level, COUNT(*) AS rows, "
            "ROUND(AVG(scale_score), 1) AS avg_scale_score, "
            "ROUND(AVG(efficiency_risk_score), 1) AS avg_efficiency_score "
            "FROM ({q}) AS x WHERE LOWER(company) = '{company}' "
            "GROUP BY 1, 2 ORDER BY rows DESC",
        ),
        (
            "11_guardrail_dist",
            "queries/11_final_recommendations.sql",
            "SELECT recommended_action, business_constraints_status, constraints_reason, "
            "COUNT(*) AS rows FROM ({q}) AS x WHERE LOWER(company) = '{company}' "
            "GROUP BY 1, 2, 3 ORDER BY rows DESC",
        ),
    ]
    for name, path, sql in tasks:
        print_rows(name, run_metabase(wrap(path, sql)))


if __name__ == "__main__":
    main()
