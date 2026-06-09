"""Campaign prioritization scores for GoTrends v2."""

from __future__ import annotations

import numpy as np
import pandas as pd


def _clip_score(value: pd.Series) -> pd.Series:
    return value.fillna(0).clip(lower=0, upper=100)


def add_campaign_scores(df: pd.DataFrame) -> pd.DataFrame:
    """Add scale, efficiency risk, and maintenance scores."""
    out = df.copy()
    out["marginal_roas_score"] = _clip_score(
        50 * out["marginal_roas"] / out["proxy_target_roas"].replace(0, np.nan)
    )
    out["opportunity_score"] = _clip_score(
        out["lost_is_budget"].fillna(0) * 100
        + (1 - out["impression_share"].fillna(0.50)) * 50
    )
    out["budget_limitation_score"] = _clip_score(out["lost_is_budget"].fillna(0) * 100)
    out["stability_score"] = np.select(
        [
            out["trend_status"].isin(["strong_positive", "positive", "normal"]),
            out["trend_status"].eq("negative"),
            out["trend_status"].eq("strong_negative"),
        ],
        [100, 50, 0],
        default=40,
    )
    out["roas_below_target_score"] = _clip_score(
        (1 - out["current_roas"] / out["proxy_target_roas"].replace(0, np.nan)) * 100
    )
    out["negative_trend_score"] = np.select(
        [
            out["trend_status"].eq("strong_negative"),
            out["trend_status"].eq("negative"),
            out["trend_status"].eq("normal"),
        ],
        [100, 70, 25],
        default=0,
    )
    out["saturation_score"] = out["saturation_level"].map(
        {"critical": 100, "high": 75, "moderate": 40, "low": 10}
    ).fillna(40)
    out["wasted_spend_score"] = _clip_score(
        out["current_cost"] / out["cost_28d"].replace(0, np.nan) * 280
    )
    out["maintenance_score"] = _clip_score(
        out["lost_is_rank"].fillna(0) * 70
        + np.where(out["ctr"] < out["campaign_type_avg_ctr"] * 0.70, 30, 0)
        + np.where(out["cvr"] < out["campaign_type_avg_cvr"] * 0.70, 30, 0)
        + np.where(out["cpc"] > out["campaign_type_avg_cpc"] * 1.30, 20, 0)
    ).round().astype(int)

    out["scale_score"] = (
        0.30 * out["marginal_roas_score"]
        + 0.25 * out["opportunity_score"]
        + 0.20 * out["budget_limitation_score"]
        + 0.15 * out["confidence_score"]
        + 0.10 * out["stability_score"]
    ).round().clip(0, 100).astype(int)
    out["efficiency_risk_score"] = (
        0.35 * out["roas_below_target_score"]
        + 0.25 * out["wasted_spend_score"]
        + 0.20 * out["negative_trend_score"]
        + 0.10 * out["saturation_score"]
        + 0.10 * out["confidence_score"]
    ).round().clip(0, 100).astype(int)
    return out
