-- GoTrends v2 - Sprint 8
-- Final recommendations with guardrails.
--
-- Grain:
--   one row per candidate campaign action on the latest available day.
--
-- This query repeats the Sprint 7 decision layer and then applies MVP
-- constraints:
--   - max 3 budget changes per day
--   - max 1 bid/target change per day
--   - bid/target change capped at 20%
--   - pure budget increase blocked when impression_share >= 0.90
--   - COS projected with available revenue proxy
--
-- Missing-source guardrails are surfaced as needs_human_review:
--   - manual block list
--   - learning status
--   - test campaign flag
--   - real company revenue/COS source
--   - actual current budget

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

latest AS (
  SELECT *
  FROM (
    SELECT
      daily.*,
      ROW_NUMBER() OVER (PARTITION BY company, campaign_id ORDER BY date DESC) AS row_num
    FROM daily
  ) AS ranked
  WHERE row_num = 1
),

attrs AS (
  SELECT
    latest.date,
    latest.company,
    latest.campaign_id,
    campaigns.campaign_status AS status,
    campaigns.bidding_strategy_type AS bidding_strategy,
    campaigns.search_impression_share::numeric AS impression_share,
    campaigns.search_budget_lost_impression_share::numeric AS lost_is_budget,
    campaigns.search_rank_lost_impression_share::numeric AS lost_is_rank
  FROM latest
  LEFT JOIN raw.gogroup_google_ads_campaigns AS campaigns
    ON campaigns.date = latest.date
    AND campaigns.company = latest.company
    AND campaigns.campaign_id = latest.campaign_id
),

lookback AS (
  SELECT
    daily.*,
    SUM(cost) OVER w28 AS cost_28d,
    SUM(conversion_value) OVER w28 / NULLIF(SUM(cost) OVER w28, 0) AS roas_28d,
    COUNT(*) FILTER (WHERE cost > 0) OVER w28 AS days_with_spend_28d,
    COUNT(*) FILTER (WHERE conversion_value > 0) OVER w28 AS positive_revenue_days_28d
  FROM daily
  WINDOW w28 AS (
    PARTITION BY company, campaign_id
    ORDER BY date
    ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
  )
),

latest_features AS (
  SELECT
    lookback.*,
    CASE
      WHEN lookback.roas > lookback.roas_28d * 1.20 THEN 'positive'
      WHEN lookback.roas < lookback.roas_28d * 0.80 THEN 'negative'
      ELSE 'normal'
    END AS trend_status,
    LEAST(100, GREATEST(0,
      ROUND(
        CASE WHEN cost_28d >= 1000 THEN 25 ELSE 25 * COALESCE(cost_28d, 0) / 1000 END
        + CASE WHEN days_with_spend_28d >= 14 THEN 25 ELSE 25 * COALESCE(days_with_spend_28d, 0) / 14 END
        + CASE WHEN positive_revenue_days_28d >= 14 THEN 25 ELSE 25 * COALESCE(positive_revenue_days_28d, 0) / 14 END
        + CASE WHEN roas_28d IS NOT NULL THEN 25 ELSE 0 END,
        0
      )
    ))::integer AS confidence_score
  FROM lookback
  JOIN latest
    ON latest.date = lookback.date
    AND latest.company = lookback.company
    AND latest.campaign_id = lookback.campaign_id
),

campaign_summary AS (
  SELECT
    company,
    campaign_id,
    MAX(campaign_type) AS campaign_type,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS proxy_target_roas,
    regr_slope(LN(conversion_value::double precision), LN(cost::double precision))
      FILTER (WHERE cost > 0 AND conversion_value > 0) AS elasticity
  FROM daily
  GROUP BY 1, 2
),

company_totals AS (
  SELECT
    date,
    company,
    SUM(cost) AS current_company_media_cost,
    SUM(conversion_value) AS current_company_revenue_proxy
  FROM latest
  GROUP BY 1, 2
),

candidates AS (
  SELECT
    latest_features.date,
    latest_features.company,
    latest_features.campaign_id,
    latest_features.campaign_name,
    latest_features.campaign_type,
    attrs.status,
    attrs.bidding_strategy,
    latest_features.cost AS current_cost,
    latest_features.conversion_value AS current_conversion_value,
    latest_features.roas AS current_roas,
    latest_features.roas_28d,
    campaign_summary.proxy_target_roas,
    campaign_summary.elasticity,
    attrs.impression_share,
    attrs.lost_is_budget,
    attrs.lost_is_rank,
    latest_features.confidence_score,
    latest_features.trend_status,
    CASE
      WHEN latest_features.roas >= campaign_summary.proxy_target_roas
        AND COALESCE(attrs.lost_is_budget, 0) > 0.05
        AND COALESCE(attrs.impression_share, 0) < 0.90
      THEN 'increase_budget'
      WHEN latest_features.roas < campaign_summary.proxy_target_roas
      THEN 'increase_troas_or_reduce_budget'
      ELSE 'monitor'
    END AS recommended_action,
    CASE
      WHEN latest_features.roas >= campaign_summary.proxy_target_roas
        AND COALESCE(attrs.lost_is_budget, 0) > 0.05
      THEN LEAST(0.15, GREATEST(0.05, COALESCE(attrs.lost_is_budget, 0)))
      WHEN latest_features.roas < campaign_summary.proxy_target_roas
      THEN -0.15
      ELSE 0
    END AS recommended_change_pct,
    CASE
      WHEN latest_features.roas >= campaign_summary.proxy_target_roas
        AND COALESCE(attrs.lost_is_budget, 0) > 0.05
      THEN latest_features.cost * LEAST(0.15, GREATEST(0.05, COALESCE(attrs.lost_is_budget, 0)))
      WHEN latest_features.roas < campaign_summary.proxy_target_roas
      THEN latest_features.cost * -0.15
      ELSE 0
    END AS expected_incremental_cost,
    CASE
      WHEN latest_features.roas >= campaign_summary.proxy_target_roas
        AND COALESCE(attrs.lost_is_budget, 0) > 0.05
      THEN latest_features.cost * LEAST(0.15, GREATEST(0.05, COALESCE(attrs.lost_is_budget, 0))) * COALESCE(campaign_summary.proxy_target_roas, latest_features.roas)
      WHEN latest_features.roas < campaign_summary.proxy_target_roas
      THEN 0
      ELSE 0
    END AS expected_incremental_revenue,
    CASE
      WHEN latest_features.confidence_score < 60 THEN 'medium'
      WHEN latest_features.roas < campaign_summary.proxy_target_roas THEN 'high'
      ELSE 'low'
    END AS risk_level
  FROM latest_features
  LEFT JOIN attrs
    ON attrs.date = latest_features.date
    AND attrs.company = latest_features.company
    AND attrs.campaign_id = latest_features.campaign_id
  LEFT JOIN campaign_summary
    ON campaign_summary.company = latest_features.company
    AND campaign_summary.campaign_id = latest_features.campaign_id
),

ranked AS (
  SELECT
    candidates.*,
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
  FROM candidates
  WHERE recommended_action <> 'monitor'
),

projected AS (
  SELECT
    ranked.*,
    company_totals.current_company_media_cost,
    company_totals.current_company_revenue_proxy,
    company_totals.current_company_media_cost / NULLIF(company_totals.current_company_revenue_proxy, 0) AS current_cos_proxy,
    (company_totals.current_company_media_cost + expected_incremental_cost)
      / NULLIF(company_totals.current_company_revenue_proxy + expected_incremental_revenue, 0) AS projected_cos_proxy
  FROM ranked
  JOIN company_totals
    ON company_totals.date = ranked.date
    AND company_totals.company = ranked.company
)

SELECT
  date AS timestamp,
  date,
  company,
  campaign_id,
  campaign_name,
  recommended_action,
  recommended_change_pct AS change_percent,
  expected_incremental_cost,
  expected_incremental_revenue,
  expected_incremental_revenue / NULLIF(expected_incremental_cost, 0) AS expected_marginal_roas,
  projected_cos_proxy AS projected_cos,
  confidence_score,
  risk_level,
  CASE
    WHEN recommended_action = 'increase_budget' AND COALESCE(impression_share, 0) >= 0.90 THEN 'blocked'
    WHEN recommended_action = 'increase_budget' AND budget_action_rank > 3 THEN 'blocked'
    WHEN recommended_action = 'increase_troas_or_reduce_budget' AND bid_action_rank > 1 THEN 'blocked'
    WHEN ABS(recommended_change_pct) > 0.20 THEN 'blocked'
    WHEN projected_cos_proxy > 0.15 THEN 'needs_human_review'
    ELSE 'needs_human_review'
  END AS business_constraints_status,
  CASE
    WHEN recommended_action = 'increase_budget' AND COALESCE(impression_share, 0) >= 0.90 THEN 'blocked_by_impression_share'
    WHEN recommended_action = 'increase_budget' AND budget_action_rank > 3 THEN 'blocked_by_daily_budget_change_limit'
    WHEN recommended_action = 'increase_troas_or_reduce_budget' AND bid_action_rank > 1 THEN 'blocked_by_daily_bid_change_limit'
    WHEN ABS(recommended_change_pct) > 0.20 THEN 'blocked_by_bid_change_pct_limit'
    WHEN projected_cos_proxy > 0.15 THEN 'cos_proxy_above_15pct_or_real_cos_missing'
    ELSE 'manual_learning_test_and_real_cos_sources_missing'
  END AS constraints_reason,
  'pending'::text AS approval_status,
  'not_executed'::text AS execution_status,
  CONCAT(
    'action=', recommended_action,
    '; confidence=', confidence_score,
    '; current_roas=', ROUND(current_roas, 2),
    '; proxy_target_roas=', ROUND(proxy_target_roas, 2),
    '; projected_cos_proxy=', ROUND(projected_cos_proxy, 4)
  ) AS reason
FROM projected;
