#!/usr/bin/env python3
"""Generate parity fixtures for the Python -> TS port.

Produces a deterministic synthetic input plus expected outputs from each
Python model. The fixtures land in ``app/tests/fixtures/parity/`` and are
committed to the repo (synthetic data, no PII, idempotent).

Layout:
    input_apice_daily.csv               5 campaigns x 60 days = 300 rows
    expected_baseline_trend.csv         baseline + trend features per row
    expected_anomaly_detection.csv      robust-z anomaly flags per row
    expected_confidence_score.csv       confidence + data sufficiency
    expected_marginal_elasticity.csv    per-campaign latest-day rollup
    expected_saturation.csv             per-campaign saturation level
    expected_lever_diagnosis.csv        primary constraint + action
    expected_campaign_scores.csv        scale / risk / maintenance scores
    expected_constraints_optimizer.csv  guardrail outcomes
    expected_projected_cos.csv          projected-COS unit cases
    summary.json                        what ran, row counts, seed

Backtesting is intentionally skipped: it consumes a decision/recommendation
log, not the daily metrics grain. The TS port should add a dedicated fixture
for it once the decision-log shape is finalized.
"""
from __future__ import annotations

import json
import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "legacy" / "python"))

from models.baseline_trend import build_baseline_trend_features  # noqa: E402
from models.anomaly_detection import add_robust_anomaly_flags  # noqa: E402
from models.confidence_score import add_confidence_features  # noqa: E402
from models.marginal_elasticity import build_campaign_elasticity_features  # noqa: E402
from models.saturation import add_saturation_features  # noqa: E402
from models.lever_diagnosis import add_lever_diagnosis  # noqa: E402
from models.campaign_scores import add_campaign_scores  # noqa: E402
from models.constraints_optimizer import apply_guardrails  # noqa: E402
from models.projected_cos import projected_cos, cos_status  # noqa: E402

OUT = ROOT / "app" / "tests" / "fixtures" / "parity"
SEED = 20260610
N_DAYS = 60
START_DATE = date(2026, 4, 12)

CAMPAIGN_TYPES = ["search", "display", "performance_max", "video", "shopping"]

# Per-campaign profiles. Each profile drives a deliberate edge case so the
# downstream port has to handle trending, low-spend, and constant-spend cases.
CAMPAIGN_PROFILES = [
    {
        "id": "c-001",
        "name": "Synthetic Campaign 001",
        "type": "search",
        "shape": "trending_up",          # monotonically increasing spend
        "base_cost": 300.0,
        "growth": 35.0,                  # +35 BRL per day
        "ctr_mean": 0.035,
        "cvr_mean": 0.040,
        "aov_mean": 250.0,
        "impression_base": 8000.0,
        "impression_share_base": 0.55,
        "impression_share_growth": 0.004,
        "lost_is_budget_base": 0.18,
        "lost_is_budget_growth": -0.002,
        "lost_is_rank_base": 0.12,
        "lost_is_rank_growth": 0.0,
    },
    {
        "id": "c-002",
        "name": "Synthetic Campaign 002",
        "type": "display",
        "shape": "trending_down",        # monotonically decreasing spend
        "base_cost": 2800.0,
        "growth": -35.0,
        "ctr_mean": 0.022,
        "cvr_mean": 0.018,
        "aov_mean": 180.0,
        "impression_base": 30000.0,
        "impression_share_base": 0.70,
        "impression_share_growth": -0.003,
        "lost_is_budget_base": 0.10,
        "lost_is_budget_growth": 0.001,
        "lost_is_rank_base": 0.20,
        "lost_is_rank_growth": 0.002,
    },
    {
        "id": "c-003",
        "name": "Synthetic Campaign 003",
        "type": "performance_max",
        "shape": "high_variance",        # noisy + occasional zero-cost day
        "base_cost": 1500.0,
        "growth": 0.0,
        "ctr_mean": 0.030,
        "cvr_mean": 0.030,
        "aov_mean": 220.0,
        "impression_base": 18000.0,
        "impression_share_base": 0.65,
        "impression_share_growth": 0.0,
        "lost_is_budget_base": 0.15,
        "lost_is_budget_growth": 0.0,
        "lost_is_rank_base": 0.18,
        "lost_is_rank_growth": 0.0,
    },
    {
        "id": "c-004",
        "name": "Synthetic Campaign 004",
        "type": "video",
        "shape": "very_low_spend",       # always under 200 BRL
        "base_cost": 120.0,
        "growth": 0.0,
        "ctr_mean": 0.040,
        "cvr_mean": 0.015,
        "aov_mean": 90.0,
        "impression_base": 4000.0,
        "impression_share_base": 0.35,
        "impression_share_growth": 0.0,
        "lost_is_budget_base": 0.30,
        "lost_is_budget_growth": 0.0,
        "lost_is_rank_base": 0.25,
        "lost_is_rank_growth": 0.0,
    },
    {
        "id": "c-005",
        "name": "Synthetic Campaign 005",
        "type": "shopping",
        "shape": "constant",             # constant 1000 BRL spend, zero variance
        "base_cost": 1000.0,
        "growth": 0.0,
        "ctr_mean": 0.028,
        "cvr_mean": 0.025,
        "aov_mean": 200.0,
        "impression_base": 12000.0,
        "impression_share_base": 0.92,   # near saturation
        "impression_share_growth": 0.0,
        "lost_is_budget_base": 0.02,
        "lost_is_budget_growth": 0.0,
        "lost_is_rank_base": 0.05,
        "lost_is_rank_growth": 0.0,
    },
]


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def build_synthetic_input() -> pd.DataFrame:
    """Generate 5 campaigns x 60 days of deterministic synthetic daily data."""
    rng = random.Random(SEED)
    rows: list[dict] = []

    for profile in CAMPAIGN_PROFILES:
        for day_idx in range(N_DAYS):
            d = START_DATE + timedelta(days=day_idx)

            # ----- cost -----
            if profile["shape"] == "constant":
                cost = profile["base_cost"]
            elif profile["shape"] == "high_variance":
                # Standard noisy day with occasional zero-cost outage.
                if day_idx % 11 == 5:
                    cost = 0.0
                else:
                    cost = profile["base_cost"] * (1 + rng.uniform(-0.5, 0.6))
            else:
                noise = rng.uniform(-0.05, 0.05)
                cost = profile["base_cost"] + profile["growth"] * day_idx
                cost *= 1 + noise
            cost = max(0.0, round(cost, 2))

            # ----- impressions / clicks -----
            if cost == 0.0:
                impressions = 0
                clicks = 0
                conversions = 0
                conversion_value = 0.0
            else:
                impressions = int(
                    _clamp(
                        profile["impression_base"] * (cost / max(profile["base_cost"], 1.0))
                        * (1 + rng.uniform(-0.08, 0.08)),
                        1000,
                        50000,
                    )
                )
                ctr = _clamp(profile["ctr_mean"] + rng.uniform(-0.005, 0.005), 0.005, 0.10)
                clicks = int(_clamp(impressions * ctr, 50, 2000))
                cvr = _clamp(profile["cvr_mean"] + rng.uniform(-0.008, 0.008), 0.0, 0.10)
                conversions = int(_clamp(clicks * cvr, 0, 50))
                # 12% of days we deliberately yield zero conversions
                if rng.random() < 0.12:
                    conversions = 0
                aov = profile["aov_mean"] * (1 + rng.uniform(-0.15, 0.15))
                conversion_value = round(conversions * aov, 2)
                # Force zero revenue when no conversions, but occasionally allow
                # a positive-cost / zero-revenue day for parity edge cases.
                if conversions == 0:
                    conversion_value = 0.0

            # ----- auction signals (used by saturation / lever / scores) -----
            impression_share = _clamp(
                profile["impression_share_base"]
                + profile["impression_share_growth"] * day_idx
                + rng.uniform(-0.015, 0.015),
                0.0,
                1.0,
            )
            lost_is_budget = _clamp(
                profile["lost_is_budget_base"]
                + profile["lost_is_budget_growth"] * day_idx
                + rng.uniform(-0.01, 0.01),
                0.0,
                1.0,
            )
            lost_is_rank = _clamp(
                profile["lost_is_rank_base"]
                + profile["lost_is_rank_growth"] * day_idx
                + rng.uniform(-0.01, 0.01),
                0.0,
                1.0,
            )

            rows.append(
                {
                    "date": d.isoformat(),
                    "company": "Apice",
                    "campaign_id": profile["id"],
                    "campaign_name": profile["name"],
                    "campaign_type": profile["type"],
                    "impressions": impressions,
                    "clicks": clicks,
                    "cost": cost,
                    "conversions": conversions,
                    "conversion_value": conversion_value,
                    "impression_share": round(impression_share, 4),
                    "lost_is_budget": round(lost_is_budget, 4),
                    "lost_is_rank": round(lost_is_rank, 4),
                }
            )

    df = pd.DataFrame(rows)
    df = df.sort_values(["company", "campaign_id", "date"]).reset_index(drop=True)
    return df


# --------------------------------------------------------------------------- #
# Latest-day enrichment (needed for saturation / lever / scores / guardrails)
# --------------------------------------------------------------------------- #
def build_latest_day_enriched(
    daily: pd.DataFrame,
    baseline: pd.DataFrame,
    confidence: pd.DataFrame,
    elasticity: pd.DataFrame,
) -> pd.DataFrame:
    """Combine latest-day rows with the per-campaign elasticity rollup.

    This mirrors how the production pipeline would feed the downstream
    saturation/lever/scores/guardrails models: take the freshest day per
    campaign, attach baseline/trend + confidence + elasticity + proxy targets,
    and supply campaign-type peer averages so peer-relative rules can fire.
    """
    bt = baseline.copy()
    bt["date"] = pd.to_datetime(bt["date"])
    latest_bt = bt.sort_values(["company", "campaign_id", "date"]).groupby(
        ["company", "campaign_id"], as_index=False
    ).tail(1)

    conf = confidence.copy()
    conf["date"] = pd.to_datetime(conf["date"])
    latest_conf = conf.sort_values(["company", "campaign_id", "date"]).groupby(
        ["company", "campaign_id"], as_index=False
    ).tail(1)[
        [
            "company",
            "campaign_id",
            "date",
            "confidence_score",
            "data_sufficiency",
            "cost_28d",
        ]
    ]

    elast = elasticity[
        [
            "company",
            "campaign_id",
            "current_roas",
            "marginal_roas",
            "elasticity",
            "current_cost",
            "current_conversion_value",
        ]
    ].copy()

    enriched = latest_bt.merge(
        latest_conf, on=["company", "campaign_id", "date"], how="left", suffixes=("", "_conf")
    )
    enriched = enriched.merge(elast, on=["company", "campaign_id"], how="left")

    # Peer averages by campaign_type over the entire window (proxy target +
    # peer CTR/CVR/CPC). These are stable demo values so the TS port can
    # reproduce them.
    peer_window = daily[daily["cost"] > 0].copy()
    peer_window["ctr"] = peer_window["clicks"] / peer_window["impressions"].replace(0, np.nan)
    peer_window["cvr"] = peer_window["conversions"] / peer_window["clicks"].replace(0, np.nan)
    peer_window["cpc"] = peer_window["cost"] / peer_window["clicks"].replace(0, np.nan)
    peer_window["roas"] = peer_window["conversion_value"] / peer_window["cost"].replace(
        0, np.nan
    )
    type_avg = peer_window.groupby(["company", "campaign_type"], as_index=False).agg(
        campaign_type_avg_ctr=("ctr", "mean"),
        campaign_type_avg_cvr=("cvr", "mean"),
        campaign_type_avg_cpc=("cpc", "mean"),
        campaign_type_avg_roas=("roas", "mean"),
    )
    enriched = enriched.merge(type_avg, on=["company", "campaign_type"], how="left")

    campaign_avg = peer_window.groupby(["company", "campaign_id"], as_index=False).agg(
        campaign_avg_roas=("roas", "mean"),
    )
    enriched = enriched.merge(campaign_avg, on=["company", "campaign_id"], how="left")

    enriched["proxy_target_roas"] = enriched["campaign_avg_roas"].combine_first(
        enriched["campaign_type_avg_roas"]
    )

    # Synthetic recommended bid-change pct so the guardrail bid-pct limit can
    # actually trigger in the fixture. Keep it deterministic.
    enriched["recommended_change_pct"] = np.where(
        enriched["lost_is_budget"] > 0.15, 0.25, 0.10
    )

    # current_roas may already be on elasticity but enforce a clean value here
    enriched["current_roas"] = enriched["current_roas"].fillna(
        enriched["conversion_value"] / enriched["cost"].replace(0, np.nan)
    )
    return enriched


def build_projected_cos_fixture() -> pd.DataFrame:
    """A small table of unit cases for projected_cos / cos_status."""
    cases = [
        # (label, current_cost, current_revenue, delta_cost, expected_inc_revenue, limit)
        ("baseline_allowed", 10000.0, 80000.0, 1500.0, 12000.0, 0.15),
        ("on_the_line", 10000.0, 80000.0, 3500.0, 10000.0, 0.15),
        ("blocked_too_costly", 10000.0, 80000.0, 5000.0, 1000.0, 0.15),
        ("zero_revenue_denominator", 0.0, 0.0, 1000.0, 0.0, 0.15),
        ("negative_delta_revenue", 10000.0, 80000.0, 2000.0, -5000.0, 0.15),
        ("custom_limit_strict", 5000.0, 40000.0, 1000.0, 8000.0, 0.10),
    ]
    rows = []
    for label, cur_cost, cur_rev, d_cost, d_rev, limit in cases:
        value = projected_cos(cur_cost, cur_rev, d_cost, d_rev)
        status = cos_status(value, limit=limit)
        rows.append(
            {
                "case": label,
                "current_media_cost": cur_cost,
                "current_revenue": cur_rev,
                "delta_media_cost": d_cost,
                "expected_incremental_revenue": d_rev,
                "limit": limit,
                "projected_cos": value,
                "status": status,
            }
        )
    return pd.DataFrame(rows)


def write_csv(df: pd.DataFrame, name: str) -> int:
    path = OUT / f"{name}.csv"
    df.to_csv(path, index=False)
    print(f"  wrote {path.relative_to(ROOT)}  ({len(df)} rows, {len(df.columns)} cols)")
    return len(df)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Generating parity fixtures into {OUT.relative_to(ROOT)}/")

    sub = build_synthetic_input()
    rows_input = write_csv(sub, "input_apice_daily")

    bt = build_baseline_trend_features(sub)
    rows_bt = write_csv(bt, "expected_baseline_trend")

    # add_robust_anomaly_flags expects ctr/cpc/cvr/roas to already exist on
    # the frame (DEFAULT_METRICS = cpc, ctr, cvr, roas, cost, conversions),
    # so it must run on top of baseline_trend rather than raw daily input.
    an = add_robust_anomaly_flags(bt)
    rows_an = write_csv(an, "expected_anomaly_detection")

    cs = add_confidence_features(sub)
    rows_cs = write_csv(cs, "expected_confidence_score")

    me = build_campaign_elasticity_features(sub)
    rows_me = write_csv(me, "expected_marginal_elasticity")

    enriched = build_latest_day_enriched(sub, bt, cs, me)
    sat = add_saturation_features(enriched)
    rows_sat = write_csv(sat, "expected_saturation")

    lev = add_lever_diagnosis(sat)
    rows_lev = write_csv(lev, "expected_lever_diagnosis")

    scores = add_campaign_scores(lev)
    rows_scores = write_csv(scores, "expected_campaign_scores")

    guard = apply_guardrails(scores)
    rows_guard = write_csv(guard, "expected_constraints_optimizer")

    pcos = build_projected_cos_fixture()
    rows_pcos = write_csv(pcos, "expected_projected_cos")

    summary = {
        "seed": SEED,
        "input_rows": rows_input,
        "campaigns": sorted(sub["campaign_id"].unique().tolist()),
        "date_min": str(sub["date"].min()),
        "date_max": str(sub["date"].max()),
        "models_with_fixtures": {
            "baseline_trend": rows_bt,
            "anomaly_detection": rows_an,
            "confidence_score": rows_cs,
            "marginal_elasticity": rows_me,
            "saturation": rows_sat,
            "lever_diagnosis": rows_lev,
            "campaign_scores": rows_scores,
            "constraints_optimizer": rows_guard,
            "projected_cos": rows_pcos,
        },
        "models_skipped": {
            "backtesting": (
                "Requires a decision/recommendation log with d7 outcomes "
                "(backtest_outcome_d7, expected_vs_realized_revenue_gap_d7, "
                "recommended_campaign_worsened_d7) which is not derivable from "
                "the daily metrics grain. Add a dedicated fixture once the "
                "decision-log schema is finalized."
            ),
        },
        "edge_cases": {
            "c-001": "trending_up_spend",
            "c-002": "trending_down_spend",
            "c-003": "high_variance_with_zero_cost_days",
            "c-004": "very_low_spend_under_200_brl",
            "c-005": "constant_1000_brl_spend_near_saturation",
        },
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print()
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
