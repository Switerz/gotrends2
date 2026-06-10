-- GoTrends v2 - Sprint 10
-- Historical decision log and backtesting view.
--
-- Grain:
--   one row per historical date + company + campaign_id decision.
--
-- Principle:
--   all decision features are computed from data available up to the decision
--   date; outcomes are measured in D+1, D+3 and D+7 windows.
--
-- Notes:
--   - This is a virtual decision log. Persist it as a physical table only after
--     the schema is approved.
--   - `conversion_value` uses `raw.gogroup_google_ads.revenue` as the available
--     proxy, consistent with previous sprints.
--   - The query keeps `monitor` rows to measure false negatives.

WITH ad_daily AS (
  SELECT
    date,
    company,
    campaign_id,
    MAX(campaign_name) AS campaign_name,
    MAX(channel_type) AS campaign_type,
    SUM(cost)::numeric AS cost,
    SUM(impressions)::bigint AS impressions,
    SUM(clicks)::bigint AS clicks,
    SUM(conversions)::numeric AS conversions,
    SUM(revenue)::numeric AS conversion_value
  FROM raw.gogroup_google_ads
  GROUP BY 1, 2, 3
),

daily AS (
  SELECT
    *,
    conversion_value / NULLIF(cost, 0) AS roas
  FROM ad_daily
  WHERE cost > 0
),

attrs AS (
  SELECT
    daily.date,
    daily.company,
    daily.campaign_id,
    campaigns.campaign_status AS status,
    campaigns.bidding_strategy_type AS bidding_strategy,
    campaigns.search_impression_share::numeric AS impression_share,
    campaigns.search_budget_lost_impression_share::numeric AS lost_is_budget,
    campaigns.search_rank_lost_impression_share::numeric AS lost_is_rank
  FROM daily
  LEFT JOIN raw.gogroup_google_ads_campaigns AS campaigns
    ON campaigns.date = daily.date
    AND campaigns.company = daily.company
    AND campaigns.campaign_id = daily.campaign_id
),

lookback AS (
  SELECT
    daily.*,
    SUM(cost) OVER w7 AS pre_cost_7d,
    SUM(conversion_value) OVER w7 AS pre_conversion_value_7d,
    SUM(conversion_value) OVER w7 / NULLIF(SUM(cost) OVER w7, 0) AS pre_roas_7d,
    SUM(cost) OVER w28 AS cost_28d,
    SUM(conversion_value) OVER w28 AS conversion_value_28d,
    SUM(conversion_value) OVER w28 / NULLIF(SUM(cost) OVER w28, 0) AS proxy_target_roas,
    COUNT(*) FILTER (WHERE cost > 0) OVER w28 AS days_with_spend_28d,
    COUNT(*) FILTER (WHERE conversion_value > 0) OVER w28 AS positive_revenue_days_28d
  FROM daily
  WINDOW
    w7 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
    ),
    w28 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
    )
),

features AS (
  SELECT
    lookback.*,
    attrs.status,
    attrs.bidding_strategy,
    attrs.impression_share,
    attrs.lost_is_budget,
    attrs.lost_is_rank,
    LEAST(100, GREATEST(0,
      ROUND(
        CASE WHEN cost_28d >= 1000 THEN 25 ELSE 25 * COALESCE(cost_28d, 0) / 1000 END
        + CASE WHEN days_with_spend_28d >= 14 THEN 25 ELSE 25 * COALESCE(days_with_spend_28d, 0) / 14 END
        + CASE WHEN positive_revenue_days_28d >= 14 THEN 25 ELSE 25 * COALESCE(positive_revenue_days_28d, 0) / 14 END
        + CASE WHEN proxy_target_roas IS NOT NULL THEN 25 ELSE 0 END,
        0
      )
    ))::integer AS confidence_score
  FROM lookback
  LEFT JOIN attrs
    ON attrs.date = lookback.date
    AND attrs.company = lookback.company
    AND attrs.campaign_id = lookback.campaign_id
  WHERE lookback.pre_cost_7d IS NOT NULL
    AND lookback.cost_28d IS NOT NULL
    AND lookback.proxy_target_roas IS NOT NULL
),

decisions AS (
  SELECT
    features.date,
    features.company,
    features.campaign_id,
    features.campaign_name,
    features.campaign_type,
    features.status,
    features.bidding_strategy,
    features.cost AS current_cost,
    features.conversion_value AS current_conversion_value,
    features.roas AS current_roas,
    features.pre_cost_7d,
    features.pre_conversion_value_7d,
    features.pre_roas_7d,
    features.proxy_target_roas,
    features.impression_share,
    features.lost_is_budget,
    features.lost_is_rank,
    features.confidence_score,
    CASE
      WHEN features.roas >= features.proxy_target_roas
        AND COALESCE(features.lost_is_budget, 0) > 0.05
        AND COALESCE(features.impression_share, 0) < 0.90
      THEN 'increase_budget'
      WHEN features.roas < features.proxy_target_roas
      THEN 'increase_troas_or_reduce_budget'
      ELSE 'monitor'
    END AS recommended_action,
    CASE
      WHEN features.roas >= features.proxy_target_roas
        AND COALESCE(features.lost_is_budget, 0) > 0.05
      THEN LEAST(0.15, GREATEST(0.05, COALESCE(features.lost_is_budget, 0)))
      WHEN features.roas < features.proxy_target_roas
      THEN -0.15
      ELSE 0
    END AS recommended_change_pct,
    CASE
      WHEN features.roas >= features.proxy_target_roas
        AND COALESCE(features.lost_is_budget, 0) > 0.05
      THEN features.cost * LEAST(0.15, GREATEST(0.05, COALESCE(features.lost_is_budget, 0)))
      WHEN features.roas < features.proxy_target_roas
      THEN features.cost * -0.15
      ELSE 0
    END AS expected_incremental_cost,
    CASE
      WHEN features.roas >= features.proxy_target_roas
        AND COALESCE(features.lost_is_budget, 0) > 0.05
      THEN features.cost * LEAST(0.15, GREATEST(0.05, COALESCE(features.lost_is_budget, 0))) * features.proxy_target_roas
      ELSE 0
    END AS expected_incremental_revenue
  FROM features
),

ranked AS (
  SELECT
    decisions.*,
    ROW_NUMBER() OVER (
      PARTITION BY date
      ORDER BY
        CASE WHEN recommended_action = 'increase_budget' THEN confidence_score ELSE 0 END DESC,
        current_cost DESC
    ) AS budget_action_rank,
    ROW_NUMBER() OVER (
      PARTITION BY date
      ORDER BY
        CASE WHEN recommended_action = 'increase_troas_or_reduce_budget' THEN confidence_score ELSE 0 END DESC,
        current_cost DESC
    ) AS bid_action_rank
  FROM decisions
),

guarded AS (
  SELECT
    ranked.*,
    CASE
      WHEN recommended_action = 'increase_budget' AND COALESCE(impression_share, 0) >= 0.90 THEN 'blocked'
      WHEN recommended_action = 'increase_budget' AND budget_action_rank > 3 THEN 'blocked'
      WHEN recommended_action = 'increase_troas_or_reduce_budget' AND bid_action_rank > 1 THEN 'blocked'
      WHEN ABS(recommended_change_pct) > 0.20 THEN 'blocked'
      WHEN recommended_action = 'monitor' THEN 'not_applicable'
      ELSE 'needs_human_review'
    END AS business_constraints_status,
    CASE
      WHEN recommended_action = 'increase_budget' AND COALESCE(impression_share, 0) >= 0.90 THEN 'blocked_by_impression_share'
      WHEN recommended_action = 'increase_budget' AND budget_action_rank > 3 THEN 'blocked_by_daily_budget_change_limit'
      WHEN recommended_action = 'increase_troas_or_reduce_budget' AND bid_action_rank > 1 THEN 'blocked_by_daily_bid_change_limit'
      WHEN ABS(recommended_change_pct) > 0.20 THEN 'blocked_by_bid_change_pct_limit'
      WHEN recommended_action = 'monitor' THEN 'monitor_no_action'
      ELSE 'manual_learning_test_and_real_cos_sources_missing'
    END AS constraints_reason
  FROM ranked
),

future AS (
  SELECT
    guarded.date,
    guarded.company,
    guarded.campaign_id,
    SUM(daily.cost) FILTER (WHERE daily.date = guarded.date + INTERVAL '1 day') AS realized_cost_d1,
    SUM(daily.conversion_value) FILTER (WHERE daily.date = guarded.date + INTERVAL '1 day') AS realized_conversion_value_d1,
    SUM(daily.cost) FILTER (WHERE daily.date > guarded.date AND daily.date <= guarded.date + INTERVAL '3 days') AS realized_cost_d3,
    SUM(daily.conversion_value) FILTER (WHERE daily.date > guarded.date AND daily.date <= guarded.date + INTERVAL '3 days') AS realized_conversion_value_d3,
    SUM(daily.cost) FILTER (WHERE daily.date > guarded.date AND daily.date <= guarded.date + INTERVAL '7 days') AS realized_cost_d7,
    SUM(daily.conversion_value) FILTER (WHERE daily.date > guarded.date AND daily.date <= guarded.date + INTERVAL '7 days') AS realized_conversion_value_d7
  FROM guarded
  LEFT JOIN daily
    ON daily.company = guarded.company
    AND daily.campaign_id = guarded.campaign_id
    AND daily.date > guarded.date
    AND daily.date <= guarded.date + INTERVAL '7 days'
  GROUP BY 1, 2, 3
),

scored AS (
  SELECT
    guarded.*,
    future.realized_cost_d1,
    future.realized_conversion_value_d1,
    future.realized_conversion_value_d1 / NULLIF(future.realized_cost_d1, 0) AS realized_roas_d1,
    future.realized_cost_d3,
    future.realized_conversion_value_d3,
    future.realized_conversion_value_d3 / NULLIF(future.realized_cost_d3, 0) AS realized_roas_d3,
    future.realized_cost_d7,
    future.realized_conversion_value_d7,
    future.realized_conversion_value_d7 / NULLIF(future.realized_cost_d7, 0) AS realized_roas_d7,
    future.realized_cost_d7 - guarded.pre_cost_7d AS realized_incremental_cost_d7,
    future.realized_conversion_value_d7 - guarded.pre_conversion_value_7d AS realized_incremental_revenue_d7
  FROM guarded
  LEFT JOIN future
    ON future.date = guarded.date
    AND future.company = guarded.company
    AND future.campaign_id = guarded.campaign_id
)

SELECT
  date AS decision_date,
  company,
  campaign_id,
  campaign_name,
  campaign_type,
  status,
  bidding_strategy,
  current_cost,
  current_conversion_value,
  current_roas,
  pre_cost_7d,
  pre_conversion_value_7d,
  pre_roas_7d,
  proxy_target_roas,
  impression_share,
  lost_is_budget,
  lost_is_rank,
  confidence_score,
  recommended_action,
  recommended_change_pct,
  expected_incremental_cost,
  expected_incremental_revenue,
  business_constraints_status,
  constraints_reason,
  realized_cost_d1,
  realized_conversion_value_d1,
  realized_roas_d1,
  realized_cost_d3,
  realized_conversion_value_d3,
  realized_roas_d3,
  realized_cost_d7,
  realized_conversion_value_d7,
  realized_roas_d7,
  realized_incremental_cost_d7,
  realized_incremental_revenue_d7,
  expected_incremental_revenue - realized_incremental_revenue_d7 AS expected_vs_realized_revenue_gap_d7,
  CASE
    WHEN realized_cost_d7 IS NULL THEN 'no_followup_data'
    WHEN recommended_action = 'increase_budget'
      AND realized_roas_d7 >= pre_roas_7d * 0.95
      AND realized_cost_d7 >= pre_cost_7d
    THEN 'hit'
    WHEN recommended_action = 'increase_troas_or_reduce_budget'
      AND realized_roas_d7 >= pre_roas_7d * 1.05
    THEN 'hit'
    WHEN recommended_action = 'monitor'
      AND realized_roas_d7 >= pre_roas_7d * 0.80
    THEN 'true_negative'
    WHEN recommended_action = 'monitor'
    THEN 'false_negative'
    ELSE 'false_positive'
  END AS backtest_outcome_d7,
  CASE
    WHEN recommended_action <> 'monitor'
      AND realized_roas_d7 < pre_roas_7d * 0.80
    THEN true
    ELSE false
  END AS recommended_campaign_worsened_d7
FROM scored;
