"""Lever diagnosis rules for GoTrends v2."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class LeverConfig:
    min_confidence_for_action: int = 60


def diagnose_primary_constraint(row: pd.Series) -> str:
    """Classify the main operational constraint for a campaign."""
    current_roas = row.get("current_roas")
    proxy_target_roas = row.get("proxy_target_roas")
    marginal_roas = row.get("marginal_roas")
    impression_share = row.get("impression_share")
    lost_is_budget = row.get("lost_is_budget")
    ctr = row.get("ctr")
    cvr = row.get("cvr")
    avg_ctr = row.get("campaign_type_avg_ctr")
    avg_cvr = row.get("campaign_type_avg_cvr")

    roas_good = pd.notna(current_roas) and pd.notna(proxy_target_roas) and current_roas >= proxy_target_roas
    marginal_good = pd.notna(marginal_roas) and pd.notna(proxy_target_roas) and marginal_roas >= proxy_target_roas

    if roas_good and pd.notna(impression_share) and impression_share >= 0.90:
        return "saturated"
    if roas_good and pd.notna(lost_is_budget) and lost_is_budget > 0.05:
        return "budget_limited"
    if roas_good and marginal_good:
        return "scale_opportunity"
    if not roas_good and pd.notna(current_roas) and pd.notna(proxy_target_roas):
        return "low_efficiency"
    if pd.notna(ctr) and pd.notna(avg_ctr) and ctr < avg_ctr * 0.70:
        return "relevance_issue"
    if pd.notna(cvr) and pd.notna(avg_cvr) and cvr < avg_cvr * 0.70:
        return "post_click_issue"
    return "monitor"


def recommend_action(row: pd.Series, config: LeverConfig | None = None) -> str:
    """Return an initial recommended action based on diagnosis and confidence."""
    config = config or LeverConfig()
    confidence = row.get("confidence_score", 0)
    primary_constraint = row.get("primary_constraint")
    saturation_level = row.get("saturation_level")
    pure_budget_blocked = bool(row.get("pure_budget_increase_blocked", False))

    if confidence < 40:
        return "monitor"
    if pure_budget_blocked and primary_constraint in {"budget_limited", "scale_opportunity"}:
        return "optimize_efficiency"
    if (
        primary_constraint in {"budget_limited", "scale_opportunity"}
        and saturation_level in {"low", "moderate"}
        and confidence >= config.min_confidence_for_action
    ):
        return "increase_budget"
    if primary_constraint in {"efficiency_risk", "low_efficiency"} and confidence >= config.min_confidence_for_action:
        return "increase_troas_or_reduce_budget"
    if primary_constraint == "saturated":
        return "optimize_efficiency"
    if primary_constraint == "relevance_issue":
        return "improve_ads_or_terms"
    if primary_constraint == "post_click_issue":
        return "review_landing_or_offer"
    return "monitor"


def add_lever_diagnosis(df: pd.DataFrame, config: LeverConfig | None = None) -> pd.DataFrame:
    """Add primary_constraint and recommended_action columns."""
    config = config or LeverConfig()
    out = df.copy()
    out["primary_constraint"] = [diagnose_primary_constraint(row) for _, row in out.iterrows()]
    out["recommended_action"] = [recommend_action(row, config) for _, row in out.iterrows()]
    return out
