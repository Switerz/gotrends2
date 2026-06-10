"""Saturation classification for GoTrends v2."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class SaturationConfig:
    high_impression_share: float = 0.90
    moderate_impression_share: float = 0.80
    high_lost_is_rank: float = 0.50
    critical_marginal_ratio: float = 0.70
    high_elasticity_floor: float = 0.35
    moderate_elasticity_floor: float = 0.70


def classify_saturation(row: pd.Series, config: SaturationConfig | None = None) -> tuple[str, str]:
    """Return saturation level and reason for one campaign row."""
    config = config or SaturationConfig()
    marginal_roas = row.get("marginal_roas")
    proxy_target_roas = row.get("proxy_target_roas")
    elasticity = row.get("elasticity")
    impression_share = row.get("impression_share")
    lost_is_rank = row.get("lost_is_rank")

    if pd.isna(marginal_roas) or pd.isna(proxy_target_roas):
        return "critical", "missing_marginal_or_proxy_target"
    if marginal_roas < proxy_target_roas * config.critical_marginal_ratio:
        return "critical", "marginal_roas_far_below_proxy_target"
    if pd.notna(elasticity) and elasticity < 0:
        return "critical", "negative_elasticity"
    if pd.notna(impression_share) and impression_share >= config.high_impression_share:
        return "high", "impression_share_above_90pct"
    if marginal_roas < proxy_target_roas:
        return "high", "marginal_roas_below_proxy_target"
    if pd.notna(elasticity) and elasticity < config.high_elasticity_floor:
        return "high", "low_elasticity"
    if pd.notna(impression_share) and impression_share >= config.moderate_impression_share:
        return "moderate", "impression_share_above_80pct"
    if pd.notna(lost_is_rank) and lost_is_rank >= config.high_lost_is_rank:
        return "moderate", "high_lost_is_rank"
    if pd.notna(elasticity) and elasticity < config.moderate_elasticity_floor:
        return "moderate", "moderate_elasticity"
    return "low", "room_to_scale"


def add_saturation_features(
    df: pd.DataFrame,
    config: SaturationConfig | None = None,
) -> pd.DataFrame:
    """Add saturation_level, reason, and pure budget block flag."""
    config = config or SaturationConfig()
    out = df.copy()

    if "proxy_target_roas" not in out.columns:
        out["proxy_target_roas"] = out.get("campaign_avg_roas").combine_first(
            out.get("campaign_type_avg_roas")
        )

    classifications = [classify_saturation(row, config) for _, row in out.iterrows()]
    out["saturation_level"] = [level for level, _ in classifications]
    out["saturation_reason"] = [reason for _, reason in classifications]
    out["pure_budget_increase_blocked"] = out["impression_share"].ge(
        config.high_impression_share
    )
    return out
