-- GoTrends v2 - Sprint 4
-- Statistical confidence features.
--
-- Grain:
--   one row per date + company + campaign_id
--
-- Purpose:
--   prevent recommendations from being driven by low-volume or unstable data.
--
-- Method:
--   - Build daily campaign metrics from raw ad-level Google Ads data.
--   - Use prior 28 campaign-day rows only for confidence features.
--   - Score volume from cost, clicks, conversions, and days with spend.
--   - Apply a volatility penalty based on ROAS coefficient of variation.

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
    SUM(revenue)::numeric AS conversion_value,
    SUM(revenue)::numeric AS revenue_real
  FROM raw.gogroup_google_ads
  GROUP BY
    date,
    company,
    campaign_id
),

campaign_attrs AS (
  SELECT
    date,
    company,
    campaign_id,
    campaign_name,
    channel_type AS campaign_type,
    campaign_status AS status,
    bidding_strategy_type AS bidding_strategy
  FROM raw.gogroup_google_ads_campaigns
),

daily AS (
  SELECT
    ad_daily.date,
    ad_daily.company,
    ad_daily.campaign_id,
    COALESCE(campaign_attrs.campaign_name, ad_daily.campaign_name) AS campaign_name,
    COALESCE(campaign_attrs.campaign_type, ad_daily.campaign_type) AS campaign_type,
    campaign_attrs.status,
    campaign_attrs.bidding_strategy,
    ad_daily.cost,
    ad_daily.impressions,
    ad_daily.clicks,
    ad_daily.conversions,
    ad_daily.conversion_value,
    ad_daily.revenue_real,
    ad_daily.clicks::numeric / NULLIF(ad_daily.impressions, 0) AS ctr,
    ad_daily.cost / NULLIF(ad_daily.clicks, 0) AS cpc,
    ad_daily.conversions / NULLIF(ad_daily.clicks, 0) AS cvr,
    ad_daily.conversion_value / NULLIF(ad_daily.cost, 0) AS roas
  FROM ad_daily
  LEFT JOIN campaign_attrs
    ON campaign_attrs.date = ad_daily.date
    AND campaign_attrs.company = ad_daily.company
    AND campaign_attrs.campaign_id = ad_daily.campaign_id
),

lookback AS (
  SELECT
    daily.*,
    SUM(cost) OVER w28 AS cost_28d,
    SUM(clicks) OVER w28 AS clicks_28d,
    SUM(conversions) OVER w28 AS conversions_28d,
    SUM(conversion_value) OVER w28 AS conversion_value_28d,
    COUNT(*) FILTER (WHERE cost > 0) OVER w28 AS days_with_spend_28d,
    COUNT(roas) OVER w28 AS roas_observations_28d,
    AVG(roas) OVER w28 AS avg_roas_28d,
    STDDEV_SAMP(roas) OVER w28 AS stddev_roas_28d,
    SUM(conversion_value) OVER w28 / NULLIF(SUM(cost) OVER w28, 0) AS roas_28d
  FROM daily
  WINDOW w28 AS (
    PARTITION BY company, campaign_id
    ORDER BY date
    ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
  )
),

score_components AS (
  SELECT
    lookback.*,
    CASE WHEN cost_28d >= 1000 THEN 25 ELSE 25 * COALESCE(cost_28d, 0) / 1000 END AS cost_score,
    CASE WHEN clicks_28d >= 500 THEN 25 ELSE 25 * COALESCE(clicks_28d, 0) / 500 END AS clicks_score,
    CASE WHEN conversions_28d >= 20 THEN 25 ELSE 25 * COALESCE(conversions_28d, 0) / 20 END AS conversions_score,
    CASE WHEN days_with_spend_28d >= 14 THEN 25 ELSE 25 * COALESCE(days_with_spend_28d, 0) / 14 END AS spend_days_score,
    stddev_roas_28d / NULLIF(ABS(avg_roas_28d), 0) AS roas_cv_28d
  FROM lookback
),

scored AS (
  SELECT
    score_components.*,
    CASE
      WHEN roas_observations_28d < 7 THEN 20
      WHEN roas_cv_28d IS NULL THEN 0
      WHEN roas_cv_28d <= 0.50 THEN 0
      WHEN roas_cv_28d >= 2.00 THEN 25
      ELSE (roas_cv_28d - 0.50) / 1.50 * 25
    END AS volatility_penalty
  FROM score_components
)

SELECT
  date,
  company,
  campaign_id,
  campaign_name,
  campaign_type,
  status,
  bidding_strategy,
  cost,
  impressions,
  clicks,
  conversions,
  conversion_value,
  revenue_real,
  ctr,
  cpc,
  cvr,
  roas,
  cost_28d,
  clicks_28d,
  conversions_28d,
  conversion_value_28d,
  days_with_spend_28d,
  roas_observations_28d,
  roas_28d,
  avg_roas_28d,
  stddev_roas_28d,
  roas_cv_28d,
  ROUND(cost_score, 2) AS cost_score,
  ROUND(clicks_score, 2) AS clicks_score,
  ROUND(conversions_score, 2) AS conversions_score,
  ROUND(spend_days_score, 2) AS spend_days_score,
  ROUND(volatility_penalty, 2) AS volatility_penalty,
  GREATEST(
    0,
    LEAST(
      100,
      ROUND(
        cost_score
        + clicks_score
        + conversions_score
        + spend_days_score
        - volatility_penalty,
        0
      )
    )
  )::integer AS confidence_score,
  CASE
    WHEN GREATEST(0, LEAST(100, ROUND(cost_score + clicks_score + conversions_score + spend_days_score - volatility_penalty, 0))) >= 75 THEN 'high'
    WHEN GREATEST(0, LEAST(100, ROUND(cost_score + clicks_score + conversions_score + spend_days_score - volatility_penalty, 0))) >= 60 THEN 'medium'
    WHEN GREATEST(0, LEAST(100, ROUND(cost_score + clicks_score + conversions_score + spend_days_score - volatility_penalty, 0))) >= 40 THEN 'low'
    ELSE 'insufficient'
  END AS data_sufficiency,
  (
    GREATEST(0, LEAST(100, ROUND(cost_score + clicks_score + conversions_score + spend_days_score - volatility_penalty, 0))) >= 60
  ) AS allow_budget_increase,
  (
    GREATEST(0, LEAST(100, ROUND(cost_score + clicks_score + conversions_score + spend_days_score - volatility_penalty, 0))) >= 75
  ) AS allow_aggressive_action
FROM scored;
