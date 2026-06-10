"""Guardrails and constrained action selection for GoTrends v2."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class GuardrailConfig:
    max_budget_changes_per_day: int = 3
    max_bid_changes_per_day: int = 1
    max_bid_change_pct: float = 0.20
    max_budget_change_share_of_initial_investment: float = 0.40
    max_projected_cos: float = 0.15


def action_kind(action: str) -> str:
    if action == "increase_budget":
        return "budget"
    if action == "increase_troas_or_reduce_budget":
        return "bid"
    return "other"


def apply_guardrails(
    candidates: pd.DataFrame,
    config: GuardrailConfig | None = None,
) -> pd.DataFrame:
    """Apply MVP guardrails to ranked candidate actions.

    Missing external sources, such as manual block lists and learning status,
    should be represented by nullable boolean columns when they become available.
    """
    config = config or GuardrailConfig()
    out = candidates.copy()
    out["action_kind"] = out["recommended_action"].map(action_kind)
    out["business_constraints_status"] = "needs_human_review"
    out["constraints_reason"] = "manual_learning_test_and_real_cos_sources_missing"

    budget_mask = out["action_kind"].eq("budget")
    bid_mask = out["action_kind"].eq("bid")
    out.loc[budget_mask, "budget_action_rank"] = (
        out[budget_mask]
        .sort_values(["date", "confidence_score"], ascending=[True, False])
        .groupby("date")
        .cumcount()
        + 1
    )
    out.loc[bid_mask, "bid_action_rank"] = (
        out[bid_mask]
        .sort_values(["date", "confidence_score"], ascending=[True, False])
        .groupby("date")
        .cumcount()
        + 1
    )

    blocked_budget_count = budget_mask & (
        out["budget_action_rank"] > config.max_budget_changes_per_day
    )
    blocked_bid_count = bid_mask & (out["bid_action_rank"] > config.max_bid_changes_per_day)
    blocked_bid_pct = bid_mask & out["recommended_change_pct"].abs().gt(
        config.max_bid_change_pct
    )
    blocked_is = budget_mask & out.get("impression_share", pd.Series(index=out.index)).ge(0.90)

    out.loc[blocked_budget_count, ["business_constraints_status", "constraints_reason"]] = [
        "blocked",
        "blocked_by_daily_budget_change_limit",
    ]
    out.loc[blocked_bid_count, ["business_constraints_status", "constraints_reason"]] = [
        "blocked",
        "blocked_by_daily_bid_change_limit",
    ]
    out.loc[blocked_bid_pct, ["business_constraints_status", "constraints_reason"]] = [
        "blocked",
        "blocked_by_bid_change_pct_limit",
    ]
    out.loc[blocked_is, ["business_constraints_status", "constraints_reason"]] = [
        "blocked",
        "blocked_by_impression_share",
    ]
    return out
