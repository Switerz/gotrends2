"""Robust anomaly detection for GoTrends v2 campaign metrics."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd


KEY_COLUMNS = ["company", "campaign_id"]
DEFAULT_METRICS = ("cpc", "ctr", "cvr", "roas", "cost", "conversions")


@dataclass(frozen=True)
class AnomalyConfig:
    lookback_days: int = 28
    robust_z_threshold: float = 3.5
    min_history_points: int = 7


def robust_z_score(value: float, history: pd.Series) -> float:
    """Compute robust z-score using median and MAD."""
    clean_history = history.dropna()
    if clean_history.empty or pd.isna(value):
        return np.nan

    median = clean_history.median()
    mad = (clean_history - median).abs().median()
    if mad == 0 or pd.isna(mad):
        return np.nan
    return 0.6745 * (value - median) / mad


def add_robust_anomaly_flags(
    df: pd.DataFrame,
    metrics: Iterable[str] = DEFAULT_METRICS,
    config: AnomalyConfig | None = None,
) -> pd.DataFrame:
    """Add robust MAD anomaly flags for each metric.

    The current day is excluded from its own history. The function assumes the
    dataframe has one row per date + company + campaign_id.
    """
    config = config or AnomalyConfig()
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out = out.sort_values(KEY_COLUMNS + ["date"])

    for metric in metrics:
        z_col = f"{metric}_robust_z"
        flag_col = f"{metric}_anomaly"
        out[z_col] = np.nan
        out[flag_col] = False

    for _, group_index in out.groupby(KEY_COLUMNS, sort=False).groups.items():
        group = out.loc[group_index].sort_values("date")
        for idx, row in group.iterrows():
            start_date = row["date"] - pd.Timedelta(days=config.lookback_days)
            history_mask = (group["date"] >= start_date) & (group["date"] < row["date"])
            history = group.loc[history_mask]

            for metric in metrics:
                z_col = f"{metric}_robust_z"
                flag_col = f"{metric}_anomaly"
                metric_history = history[metric].dropna()
                if len(metric_history) < config.min_history_points:
                    continue

                z_score = robust_z_score(row[metric], metric_history)
                out.at[idx, z_col] = z_score
                out.at[idx, flag_col] = bool(
                    pd.notna(z_score) and abs(z_score) >= config.robust_z_threshold
                )

    anomaly_cols = [f"{metric}_anomaly" for metric in metrics]
    out["anomaly_count"] = out[anomaly_cols].sum(axis=1)
    out["critical_anomaly_block"] = (
        out.get("roas_anomaly", False)
        | out.get("cost_anomaly", False)
        | out.get("conversions_anomaly", False)
    )
    return out
