"""Projected COS helpers for GoTrends v2."""

from __future__ import annotations

import numpy as np


def projected_cos(
    current_media_cost: float,
    current_revenue: float,
    delta_media_cost: float,
    expected_incremental_revenue: float,
) -> float:
    """Compute projected cost of sales after a proposed media change."""
    denominator = current_revenue + expected_incremental_revenue
    if denominator == 0:
        return np.nan
    return (current_media_cost + delta_media_cost) / denominator


def cos_status(value: float, limit: float = 0.15) -> str:
    """Classify a projected COS value."""
    if np.isnan(value):
        return "needs_human_review"
    return "allowed" if value <= limit else "blocked"
