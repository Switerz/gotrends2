"""Marginal ROAS and elasticity helpers for GoTrends v2."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


KEY_COLUMNS = ["company", "campaign_id"]


@dataclass(frozen=True)
class ElasticityConfig:
    n_bands: int = 4
    min_campaign_days: int = 28
    min_positive_revenue_days: int = 14


def add_spend_bands(
    df: pd.DataFrame,
    group_columns: list[str] | None = None,
    config: ElasticityConfig | None = None,
) -> pd.DataFrame:
    """Assign quantile spend bands inside each group."""
    config = config or ElasticityConfig()
    group_columns = group_columns or KEY_COLUMNS
    out = df.copy()
    out = out[out["cost"] > 0].copy()

    def assign_bands(cost: pd.Series) -> pd.Series:
        if len(cost) <= 1:
            return pd.Series(1, index=cost.index)
        band_count = min(config.n_bands, len(cost))
        return pd.qcut(
            cost.rank(method="first"),
            band_count,
            labels=False,
            duplicates="drop",
        ).add(1)

    out["spend_band"] = (
        out.groupby(group_columns)["cost"]
        .transform(assign_bands)
        .astype(int)
    )
    return out


def build_spend_band_summary(
    df: pd.DataFrame,
    group_columns: list[str] | None = None,
    config: ElasticityConfig | None = None,
) -> pd.DataFrame:
    """Summarize average and marginal ROAS by spend band."""
    config = config or ElasticityConfig()
    group_columns = group_columns or KEY_COLUMNS
    banded = add_spend_bands(df, group_columns=group_columns, config=config)
    summary = (
        banded.groupby(group_columns + ["spend_band"], as_index=False)
        .agg(
            days_in_band=("date", "count"),
            spend_band_min=("cost", "min"),
            spend_band_max=("cost", "max"),
            avg_cost=("cost", "mean"),
            avg_conversion_value=("conversion_value", "mean"),
            total_cost=("cost", "sum"),
            total_conversion_value=("conversion_value", "sum"),
        )
        .sort_values(group_columns + ["spend_band"])
    )
    summary["avg_roas"] = summary["total_conversion_value"] / summary["total_cost"].replace(0, np.nan)
    summary["incremental_cost"] = summary.groupby(group_columns)["avg_cost"].diff()
    summary["incremental_conversion_value"] = summary.groupby(group_columns)[
        "avg_conversion_value"
    ].diff()
    summary["marginal_roas"] = summary["incremental_conversion_value"] / summary[
        "incremental_cost"
    ].replace(0, np.nan)
    return summary


def estimate_log_log_elasticity(df: pd.DataFrame) -> float:
    """Estimate beta from log(revenue) = alpha + beta * log(cost)."""
    sample = df[(df["cost"] > 0) & (df["conversion_value"] > 0)].copy()
    if len(sample) < 3:
        return np.nan
    x = np.log(sample["cost"].to_numpy(dtype=float))
    y = np.log(sample["conversion_value"].to_numpy(dtype=float))
    if np.isclose(np.var(x), 0):
        return np.nan
    return float(np.polyfit(x, y, 1)[0])


def build_campaign_elasticity_features(
    df: pd.DataFrame,
    config: ElasticityConfig | None = None,
) -> pd.DataFrame:
    """Build latest-day marginal ROAS and elasticity features by campaign."""
    config = config or ElasticityConfig()
    daily = df[df["cost"] > 0].copy()
    daily["date"] = pd.to_datetime(daily["date"], errors="coerce")

    campaign_bands = build_spend_band_summary(daily, KEY_COLUMNS, config)
    type_bands = build_spend_band_summary(daily, ["company", "campaign_type"], config)

    campaign_summary = (
        daily.groupby(KEY_COLUMNS, as_index=False)
        .agg(
            campaign_name=("campaign_name", "last"),
            campaign_type=("campaign_type", "last"),
            days_with_spend=("date", "count"),
            positive_revenue_days=("conversion_value", lambda s: (s > 0).sum()),
            avg_roas=("conversion_value", "sum"),
            total_cost=("cost", "sum"),
        )
    )
    campaign_summary["avg_roas"] = campaign_summary["avg_roas"] / campaign_summary[
        "total_cost"
    ].replace(0, np.nan)
    elasticity = (
        daily.groupby(KEY_COLUMNS, sort=False)[["cost", "conversion_value"]]
        .apply(estimate_log_log_elasticity)
        .reset_index(name="elasticity")
    )
    campaign_summary = campaign_summary.merge(elasticity, on=KEY_COLUMNS, how="left")

    latest = (
        daily.sort_values(KEY_COLUMNS + ["date"])
        .groupby(KEY_COLUMNS, as_index=False)
        .tail(1)
        .copy()
    )

    rows = []
    type_band_lookup = {
        key: group.sort_values("spend_band")
        for key, group in type_bands.groupby(["company", "campaign_type"], sort=False)
    }
    campaign_band_lookup = {
        key: group.sort_values("spend_band")
        for key, group in campaign_bands.groupby(KEY_COLUMNS, sort=False)
    }
    summary_lookup = {
        (row.company, row.campaign_id): row
        for row in campaign_summary.itertuples(index=False)
    }

    for row in latest.itertuples(index=False):
        key = (row.company, row.campaign_id)
        summary = summary_lookup[key]
        use_campaign = (
            summary.days_with_spend >= config.min_campaign_days
            and summary.positive_revenue_days >= config.min_positive_revenue_days
            and key in campaign_band_lookup
        )
        bands = campaign_band_lookup.get(key) if use_campaign else None
        model_level = "campaign"
        if bands is None or bands["marginal_roas"].dropna().empty:
            bands = type_band_lookup.get((row.company, row.campaign_type))
            model_level = "campaign_type"

        target_band = None
        if bands is not None and not bands.empty:
            candidates = bands[bands["spend_band_max"] >= row.cost]
            target_band = candidates.iloc[0] if not candidates.empty else bands.iloc[-1]

        rows.append(
            {
                "date": row.date,
                "company": row.company,
                "campaign_id": row.campaign_id,
                "campaign_name": row.campaign_name,
                "campaign_type": row.campaign_type,
                "current_cost": row.cost,
                "current_conversion_value": row.conversion_value,
                "current_roas": row.conversion_value / row.cost if row.cost else np.nan,
                "days_with_spend": summary.days_with_spend,
                "positive_revenue_days": summary.positive_revenue_days,
                "model_level_used": model_level,
                "marginal_roas": np.nan
                if target_band is None
                else target_band.get("marginal_roas", np.nan),
                "elasticity": summary.elasticity if model_level == "campaign" else np.nan,
                "recommended_spend_band_min": np.nan
                if target_band is None
                else target_band["spend_band_min"],
                "recommended_spend_band_max": np.nan
                if target_band is None
                else target_band["spend_band_max"],
            }
        )

    return pd.DataFrame(rows)
