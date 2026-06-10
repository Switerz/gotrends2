"""Statistical confidence scoring for GoTrends v2."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


KEY_COLUMNS = ["company", "campaign_id"]


@dataclass(frozen=True)
class ConfidenceConfig:
    cost_threshold: float = 1000.0
    clicks_threshold: float = 500.0
    conversions_threshold: float = 20.0
    days_with_spend_threshold: int = 14
    min_roas_observations: int = 7
    low_threshold: int = 40
    medium_threshold: int = 60
    high_threshold: int = 75


def _capped_component(value: pd.Series, threshold: float) -> pd.Series:
    return (25 * value.fillna(0) / threshold).clip(lower=0, upper=25)


def add_confidence_features(
    df: pd.DataFrame,
    config: ConfidenceConfig | None = None,
) -> pd.DataFrame:
    """Add 28-day confidence features to daily campaign metrics.

    The current day is excluded from its own lookback.
    """
    config = config or ConfidenceConfig()
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out = out.sort_values(KEY_COLUMNS + ["date"])

    grouped = out.groupby(KEY_COLUMNS, group_keys=False)
    out["cost_28d"] = grouped["cost"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).sum()
    )
    out["clicks_28d"] = grouped["clicks"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).sum()
    )
    out["conversions_28d"] = grouped["conversions"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).sum()
    )
    out["conversion_value_28d"] = grouped["conversion_value"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).sum()
    )
    out["days_with_spend_28d"] = grouped["cost"].transform(
        lambda s: (s.shift(1) > 0).rolling(28, min_periods=1).sum()
    )

    if "roas" not in out.columns:
        out["roas"] = out["conversion_value"] / out["cost"].replace(0, np.nan)

    out["roas_observations_28d"] = grouped["roas"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).count()
    )
    out["avg_roas_28d"] = grouped["roas"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=1).mean()
    )
    out["stddev_roas_28d"] = grouped["roas"].transform(
        lambda s: s.shift(1).rolling(28, min_periods=2).std()
    )
    out["roas_28d"] = out["conversion_value_28d"] / out["cost_28d"].replace(0, np.nan)
    out["roas_cv_28d"] = out["stddev_roas_28d"] / out["avg_roas_28d"].abs().replace(0, np.nan)

    out["cost_score"] = _capped_component(out["cost_28d"], config.cost_threshold)
    out["clicks_score"] = _capped_component(out["clicks_28d"], config.clicks_threshold)
    out["conversions_score"] = _capped_component(
        out["conversions_28d"], config.conversions_threshold
    )
    out["spend_days_score"] = _capped_component(
        out["days_with_spend_28d"], config.days_with_spend_threshold
    )

    volatility_penalty = ((out["roas_cv_28d"] - 0.5) / 1.5 * 25).clip(lower=0, upper=25)
    volatility_penalty = volatility_penalty.fillna(0)
    volatility_penalty = volatility_penalty.mask(
        out["roas_observations_28d"] < config.min_roas_observations,
        20,
    )
    out["volatility_penalty"] = volatility_penalty

    raw_score = (
        out["cost_score"]
        + out["clicks_score"]
        + out["conversions_score"]
        + out["spend_days_score"]
        - out["volatility_penalty"]
    )
    out["confidence_score"] = raw_score.round().clip(lower=0, upper=100).astype(int)
    out["data_sufficiency"] = pd.cut(
        out["confidence_score"],
        bins=[-1, config.low_threshold - 1, config.medium_threshold - 1, config.high_threshold - 1, 100],
        labels=["insufficient", "low", "medium", "high"],
    ).astype(str)
    out["allow_budget_increase"] = out["confidence_score"] >= config.medium_threshold
    out["allow_aggressive_action"] = out["confidence_score"] >= config.high_threshold
    return out


def bootstrap_roas(
    daily_df: pd.DataFrame,
    n_bootstrap: int = 1000,
    random_state: int | None = 42,
) -> dict[str, float]:
    """Estimate ROAS uncertainty by resampling daily rows.

    This is optional for the MVP and should only be used when the input contains
    enough historical rows for one campaign.
    """
    sample = daily_df[["cost", "conversion_value"]].dropna()
    sample = sample[sample["cost"] > 0]
    if sample.empty:
        return {
            "roas_p10": np.nan,
            "roas_p50": np.nan,
            "roas_p90": np.nan,
        }

    rng = np.random.default_rng(random_state)
    roas_values = []
    values = sample.to_numpy(dtype=float)
    for _ in range(n_bootstrap):
        indexes = rng.integers(0, len(values), size=len(values))
        boot = values[indexes]
        cost = boot[:, 0].sum()
        revenue = boot[:, 1].sum()
        if cost > 0:
            roas_values.append(revenue / cost)

    if not roas_values:
        return {
            "roas_p10": np.nan,
            "roas_p50": np.nan,
            "roas_p90": np.nan,
        }

    percentiles = np.percentile(roas_values, [10, 50, 90])
    return {
        "roas_p10": float(percentiles[0]),
        "roas_p50": float(percentiles[1]),
        "roas_p90": float(percentiles[2]),
    }
