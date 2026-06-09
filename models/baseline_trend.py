"""Baseline and trend features for GoTrends v2.

The functions in this module expect the Sprint 1 daily campaign metrics grain:
one row per date + company + campaign_id.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


KEY_COLUMNS = ["company", "campaign_id"]


@dataclass(frozen=True)
class BaselineConfig:
    ewma_alpha: float = 0.4
    strong_positive_ratio: float = 1.35
    positive_ratio: float = 1.20
    negative_ratio: float = 0.80
    strong_negative_ratio: float = 0.65


def safe_divide(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    """Return numerator / denominator with nulls where denominator is zero."""
    denominator = denominator.replace(0, np.nan)
    return numerator / denominator


def add_base_ratios(df: pd.DataFrame) -> pd.DataFrame:
    """Add CTR, CPC, CVR, and ROAS using safe division."""
    out = df.copy()
    out["ctr"] = safe_divide(out["clicks"], out["impressions"])
    out["cpc"] = safe_divide(out["cost"], out["clicks"])
    out["cvr"] = safe_divide(out["conversions"], out["clicks"])
    out["roas"] = safe_divide(out["conversion_value"], out["cost"])
    return out


def add_rolling_baselines(df: pd.DataFrame) -> pd.DataFrame:
    """Add trailing 7d, 14d, 28d and same-weekday ROAS baselines.

    Rolling windows use prior rows only, so the current day is not included in
    its own baseline.
    """
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out = out.sort_values(KEY_COLUMNS + ["date"])

    grouped = out.groupby(KEY_COLUMNS, group_keys=False)
    for window in (7, 14, 28):
        cost_col = f"cost_{window}d"
        value_col = f"conversion_value_{window}d"
        roas_col = f"roas_{window}d"
        out[cost_col] = grouped["cost"].transform(
            lambda s: s.shift(1).rolling(window, min_periods=1).sum()
        )
        out[value_col] = grouped["conversion_value"].transform(
            lambda s: s.shift(1).rolling(window, min_periods=1).sum()
        )
        out[roas_col] = safe_divide(out[value_col], out[cost_col])

    out["clicks_28d"] = grouped["clicks"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).sum()
    )
    out["conversions_28d"] = grouped["conversions"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).sum()
    )

    out["weekday"] = out["date"].dt.dayofweek
    weekday_grouped = out.groupby(KEY_COLUMNS + ["weekday"], group_keys=False)
    out["same_weekday_cost"] = weekday_grouped["cost"].transform(
        lambda s: s.shift(1).rolling(8, min_periods=1).sum()
    )
    out["same_weekday_conversion_value"] = weekday_grouped["conversion_value"].transform(
        lambda s: s.shift(1).rolling(8, min_periods=1).sum()
    )
    out["same_weekday_roas"] = safe_divide(
        out["same_weekday_conversion_value"], out["same_weekday_cost"]
    )
    return out.drop(columns=["same_weekday_cost", "same_weekday_conversion_value"])


def add_ewma_roas(df: pd.DataFrame, alpha: float = 0.4) -> pd.DataFrame:
    """Add EWMA ROAS per campaign using prior-day values only."""
    out = df.copy()
    out = out.sort_values(KEY_COLUMNS + ["date"])
    out["ewma_roas"] = (
        out.groupby(KEY_COLUMNS)["roas"]
        .transform(lambda s: s.shift(1).ewm(alpha=alpha, adjust=False).mean())
    )
    return out


def classify_trend(
    roas: float | None,
    roas_28d: float | None,
    config: BaselineConfig,
) -> str:
    if pd.isna(roas) or pd.isna(roas_28d):
        return "insufficient_data"
    if roas > roas_28d * config.strong_positive_ratio:
        return "strong_positive"
    if roas > roas_28d * config.positive_ratio:
        return "positive"
    if roas < roas_28d * config.strong_negative_ratio:
        return "strong_negative"
    if roas < roas_28d * config.negative_ratio:
        return "negative"
    return "normal"


def add_trend_status(
    df: pd.DataFrame,
    config: BaselineConfig | None = None,
) -> pd.DataFrame:
    """Classify each row against the trailing 28-day ROAS baseline."""
    config = config or BaselineConfig()
    out = df.copy()
    out["trend_status"] = [
        classify_trend(roas, roas_28d, config)
        for roas, roas_28d in zip(out["roas"], out["roas_28d"], strict=False)
    ]
    return out


def build_baseline_trend_features(
    df: pd.DataFrame,
    config: BaselineConfig | None = None,
) -> pd.DataFrame:
    """Build Sprint 3 baseline and trend features."""
    config = config or BaselineConfig()
    out = add_base_ratios(df)
    out = add_rolling_baselines(out)
    out = add_ewma_roas(out, alpha=config.ewma_alpha)
    out = add_trend_status(out, config=config)
    return out
