"""Backtesting helpers for GoTrends v2 recommendation logs."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
from math import isnan
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class BacktestSummary:
    rows: int
    evaluated_rows: int
    candidate_rows: int
    hit_rate: float
    false_positive_rate: float
    false_negative_rate: float
    worsened_recommended_rows: int
    avg_expected_vs_realized_revenue_gap: float


REQUIRED_COLUMNS = {
    "recommended_action",
    "business_constraints_status",
    "backtest_outcome_d7",
    "expected_vs_realized_revenue_gap_d7",
    "recommended_campaign_worsened_d7",
}


def validate_backtest_rows(rows: Iterable[Mapping[str, Any]]) -> None:
    """Validate the minimal schema expected from queries/12_decision_backtest.sql."""
    rows = list(rows)
    if not rows:
        return
    missing = sorted(REQUIRED_COLUMNS - set(rows[0]))
    if missing:
        raise ValueError(f"Missing backtest columns: {', '.join(missing)}")


def summarize_backtest(data: Any) -> BacktestSummary:
    """Summarize Sprint 10 backtest outcomes.

    `data` may be a list of dictionaries or a DataFrame-like object with
    `to_dict(orient="records")`.
    """
    rows = _as_rows(data)
    validate_backtest_rows(rows)

    evaluated = [row for row in rows if row.get("backtest_outcome_d7") != "no_followup_data"]
    actionable = [
        row
        for row in evaluated
        if row.get("recommended_action") != "monitor"
        and row.get("business_constraints_status") != "blocked"
    ]
    monitors = [row for row in evaluated if row.get("recommended_action") == "monitor"]

    hit_rate = _safe_mean(row.get("backtest_outcome_d7") == "hit" for row in actionable)
    false_positive_rate = _safe_mean(
        row.get("backtest_outcome_d7") == "false_positive" for row in actionable
    )
    false_negative_rate = _safe_mean(
        row.get("backtest_outcome_d7") == "false_negative" for row in monitors
    )
    avg_gap = _safe_mean(
        _to_float(row.get("expected_vs_realized_revenue_gap_d7")) for row in actionable
    )
    worsened = sum(bool(row.get("recommended_campaign_worsened_d7")) for row in actionable)

    return BacktestSummary(
        rows=len(rows),
        evaluated_rows=len(evaluated),
        candidate_rows=len(actionable),
        hit_rate=hit_rate,
        false_positive_rate=false_positive_rate,
        false_negative_rate=false_negative_rate,
        worsened_recommended_rows=worsened,
        avg_expected_vs_realized_revenue_gap=avg_gap,
    )


def outcome_counts(data: Any) -> list[dict[str, Any]]:
    """Return outcome counts by action and guardrail status."""
    rows = _as_rows(data)
    validate_backtest_rows(rows)
    counter = Counter(
        (
            row.get("recommended_action"),
            row.get("business_constraints_status"),
            row.get("backtest_outcome_d7"),
        )
        for row in rows
    )
    return [
        {
            "recommended_action": action,
            "business_constraints_status": status,
            "backtest_outcome_d7": outcome,
            "rows": count,
        }
        for (action, status, outcome), count in counter.most_common()
    ]


def dashboard_metrics(data: Any) -> dict[str, float | int]:
    """Return compact metrics for a simple dashboard card layer."""
    return asdict(summarize_backtest(data))


def decision_log_columns() -> list[str]:
    """Document the recommended physical decision-log columns."""
    return [
        "decision_date",
        "company",
        "campaign_id",
        "campaign_name",
        "recommended_action",
        "recommended_change_pct",
        "expected_incremental_cost",
        "expected_incremental_revenue",
        "business_constraints_status",
        "constraints_reason",
        "approval_status",
        "execution_status",
        "created_at",
    ]


def _as_rows(data: Any) -> list[Mapping[str, Any]]:
    if isinstance(data, list):
        return data
    if hasattr(data, "to_dict"):
        return data.to_dict(orient="records")
    return list(data)


def _safe_mean(values: Iterable[Any]) -> float:
    numeric = [_to_float(value) for value in values]
    numeric = [value for value in numeric if value is not None and not isnan(value)]
    if not numeric:
        return float("nan")
    return sum(numeric) / len(numeric)


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
