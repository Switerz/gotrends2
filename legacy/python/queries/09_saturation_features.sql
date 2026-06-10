-- GoTrends v2 - Sprint 6
-- Saturation features.
--
-- Grain:
--   one row per company + campaign_id on the latest available campaign day.
--
-- Inputs:
--   - marginal_roas, elasticity, recommended spend band from Sprint 5 logic.
--   - impression share and lost impression share from raw.gogroup_google_ads_campaigns.
--
-- Notes:
--   - target_roas is not available in the current source.
--   - proxy_target_roas uses campaign_avg_roas, falling back to campaign_type_avg_roas.
--   - forecast_budget_consumption is NULL because Sprint 2 intraday is pending and
--     budget was not found in Sprint 0.
--   - impression share fields are fractions from 0 to 1.

WITH ad_daily AS (
  SELECT
    date,
    company,
    campaign_id,
    MAX(campaign_name) AS campaign_name,
    MAX(channel_type) AS campaign_type,
    SUM(cost)::numeric AS cost,
    SUM(revenue)::numeric AS conversion_value
  FROM raw.gogroup_google_ads
  GROUP BY
    date,
    company,
    campaign_id
),

daily AS (
  SELECT
    date,
    company,
    campaign_id,
    campaign_name,
    campaign_type,
    cost,
    conversion_value,
    conversion_value / NULLIF(cost, 0) AS roas
  FROM ad_daily
  WHERE cost > 0
),

latest_campaign_day AS (
  SELECT *
  FROM (
    SELECT
      daily.*,
      ROW_NUMBER() OVER (
        PARTITION BY company, campaign_id
        ORDER BY date DESC
      ) AS row_num
    FROM daily
  ) AS ranked
  WHERE row_num = 1
),

latest_campaign_attrs AS (
  SELECT
    latest.date,
    latest.company,
    latest.campaign_id,
    attrs.campaign_status AS status,
    attrs.bidding_strategy_type AS bidding_strategy,
    attrs.search_impression_share::numeric AS impression_share,
    attrs.search_budget_lost_impression_share::numeric AS lost_is_budget,
    attrs.search_rank_lost_impression_share::numeric AS lost_is_rank
  FROM latest_campaign_day AS latest
  LEFT JOIN raw.gogroup_google_ads_campaigns AS attrs
    ON attrs.date = latest.date
    AND attrs.company = latest.company
    AND attrs.campaign_id = latest.campaign_id
),

campaign_summary AS (
  SELECT
    company,
    campaign_id,
    MAX(campaign_name) AS campaign_name,
    MAX(campaign_type) AS campaign_type,
    COUNT(*) AS days_with_spend,
    COUNT(*) FILTER (WHERE conversion_value > 0) AS positive_revenue_days,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS campaign_avg_roas,
    regr_slope(LN(conversion_value::double precision), LN(cost::double precision))
      FILTER (WHERE cost > 0 AND conversion_value > 0) AS campaign_elasticity
  FROM daily
  GROUP BY
    company,
    campaign_id
),

type_summary AS (
  SELECT
    company,
    campaign_type,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS campaign_type_avg_roas,
    regr_slope(LN(conversion_value::double precision), LN(cost::double precision))
      FILTER (WHERE cost > 0 AND conversion_value > 0) AS campaign_type_elasticity
  FROM daily
  GROUP BY
    company,
    campaign_type
),

campaign_ranked AS (
  SELECT
    daily.*,
    NTILE(4) OVER (
      PARTITION BY company, campaign_id
      ORDER BY cost
    ) AS spend_band
  FROM daily
),

campaign_bands AS (
  SELECT
    company,
    campaign_id,
    spend_band,
    MIN(cost) AS spend_band_min,
    MAX(cost) AS spend_band_max,
    AVG(cost) AS avg_cost,
    AVG(conversion_value) AS avg_conversion_value,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS avg_roas
  FROM campaign_ranked
  GROUP BY
    company,
    campaign_id,
    spend_band
),

campaign_incremental AS (
  SELECT
    campaign_bands.*,
    (avg_conversion_value - LAG(avg_conversion_value) OVER w)
      / NULLIF(avg_cost - LAG(avg_cost) OVER w, 0) AS marginal_roas
  FROM campaign_bands
  WINDOW w AS (
    PARTITION BY company, campaign_id
    ORDER BY spend_band
  )
),

type_ranked AS (
  SELECT
    daily.*,
    NTILE(4) OVER (
      PARTITION BY company, campaign_type
      ORDER BY cost
    ) AS spend_band
  FROM daily
),

type_bands AS (
  SELECT
    company,
    campaign_type,
    spend_band,
    MIN(cost) AS spend_band_min,
    MAX(cost) AS spend_band_max,
    AVG(cost) AS avg_cost,
    AVG(conversion_value) AS avg_conversion_value,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS avg_roas
  FROM type_ranked
  GROUP BY
    company,
    campaign_type,
    spend_band
),

type_incremental AS (
  SELECT
    type_bands.*,
    (avg_conversion_value - LAG(avg_conversion_value) OVER w)
      / NULLIF(avg_cost - LAG(avg_cost) OVER w, 0) AS marginal_roas
  FROM type_bands
  WINDOW w AS (
    PARTITION BY company, campaign_type
    ORDER BY spend_band
  )
),

campaign_current_band AS (
  SELECT DISTINCT ON (latest.company, latest.campaign_id)
    latest.company,
    latest.campaign_id,
    campaign_incremental.spend_band AS current_spend_band
  FROM latest_campaign_day AS latest
  JOIN campaign_incremental
    ON campaign_incremental.company = latest.company
    AND campaign_incremental.campaign_id = latest.campaign_id
  ORDER BY
    latest.company,
    latest.campaign_id,
    CASE
      WHEN latest.cost BETWEEN campaign_incremental.spend_band_min AND campaign_incremental.spend_band_max THEN 0
      ELSE 1
    END,
    ABS(campaign_incremental.avg_cost - latest.cost)
),

type_current_band AS (
  SELECT DISTINCT ON (latest.company, latest.campaign_id)
    latest.company,
    latest.campaign_id,
    type_incremental.spend_band AS current_spend_band
  FROM latest_campaign_day AS latest
  JOIN type_incremental
    ON type_incremental.company = latest.company
    AND type_incremental.campaign_type = latest.campaign_type
  ORDER BY
    latest.company,
    latest.campaign_id,
    CASE
      WHEN latest.cost BETWEEN type_incremental.spend_band_min AND type_incremental.spend_band_max THEN 0
      ELSE 1
    END,
    ABS(type_incremental.avg_cost - latest.cost)
),

campaign_target_band AS (
  SELECT DISTINCT ON (latest.company, latest.campaign_id)
    campaign_incremental.*
  FROM latest_campaign_day AS latest
  JOIN campaign_current_band
    ON campaign_current_band.company = latest.company
    AND campaign_current_band.campaign_id = latest.campaign_id
  JOIN campaign_incremental
    ON campaign_incremental.company = latest.company
    AND campaign_incremental.campaign_id = latest.campaign_id
    AND campaign_incremental.spend_band >= campaign_current_band.current_spend_band
  ORDER BY
    latest.company,
    latest.campaign_id,
    campaign_incremental.spend_band
),

type_target_band AS (
  SELECT DISTINCT ON (latest.company, latest.campaign_id)
    latest.company AS source_company,
    latest.campaign_id AS source_campaign_id,
    type_incremental.*
  FROM latest_campaign_day AS latest
  JOIN type_current_band
    ON type_current_band.company = latest.company
    AND type_current_band.campaign_id = latest.campaign_id
  JOIN type_incremental
    ON type_incremental.company = latest.company
    AND type_incremental.campaign_type = latest.campaign_type
    AND type_incremental.spend_band >= type_current_band.current_spend_band
  ORDER BY
    latest.company,
    latest.campaign_id,
    type_incremental.spend_band
),

marginal AS (
  SELECT
    latest.date,
    latest.company,
    latest.campaign_id,
    latest.campaign_name,
    latest.campaign_type,
    latest.cost AS current_cost,
    latest.conversion_value AS current_conversion_value,
    latest.roas AS current_roas,
    campaign_summary.days_with_spend,
    campaign_summary.positive_revenue_days,
    CASE
      WHEN campaign_summary.days_with_spend >= 28
        AND campaign_summary.positive_revenue_days >= 14
        AND campaign_target_band.marginal_roas IS NOT NULL
      THEN 'campaign'
      ELSE 'campaign_type'
    END AS model_level_used,
    COALESCE(
      CASE
        WHEN campaign_summary.days_with_spend >= 28
          AND campaign_summary.positive_revenue_days >= 14
          AND campaign_target_band.marginal_roas IS NOT NULL
        THEN campaign_target_band.marginal_roas
      END,
      type_target_band.marginal_roas,
      campaign_target_band.avg_roas,
      type_target_band.avg_roas
    ) AS marginal_roas,
    COALESCE(
      CASE
        WHEN campaign_summary.days_with_spend >= 28
          AND campaign_summary.positive_revenue_days >= 14
        THEN campaign_summary.campaign_elasticity
      END,
      type_summary.campaign_type_elasticity
    ) AS elasticity,
    COALESCE(
      CASE
        WHEN campaign_summary.days_with_spend >= 28
          AND campaign_summary.positive_revenue_days >= 14
          AND campaign_target_band.marginal_roas IS NOT NULL
        THEN campaign_target_band.spend_band_min
      END,
      type_target_band.spend_band_min
    ) AS recommended_spend_band_min,
    COALESCE(
      CASE
        WHEN campaign_summary.days_with_spend >= 28
          AND campaign_summary.positive_revenue_days >= 14
          AND campaign_target_band.marginal_roas IS NOT NULL
        THEN campaign_target_band.spend_band_max
      END,
      type_target_band.spend_band_max
    ) AS recommended_spend_band_max,
    campaign_summary.campaign_avg_roas,
    type_summary.campaign_type_avg_roas,
    campaign_summary.campaign_elasticity,
    type_summary.campaign_type_elasticity
  FROM latest_campaign_day AS latest
  JOIN campaign_summary
    ON campaign_summary.company = latest.company
    AND campaign_summary.campaign_id = latest.campaign_id
  LEFT JOIN type_summary
    ON type_summary.company = latest.company
    AND type_summary.campaign_type = latest.campaign_type
  LEFT JOIN campaign_target_band
    ON campaign_target_band.company = latest.company
    AND campaign_target_band.campaign_id = latest.campaign_id
  LEFT JOIN type_target_band
    ON type_target_band.source_company = latest.company
    AND type_target_band.source_campaign_id = latest.campaign_id
),

features AS (
  SELECT
    marginal.*,
    attrs.status,
    attrs.bidding_strategy,
    attrs.impression_share,
    attrs.lost_is_budget,
    attrs.lost_is_rank,
    NULL::numeric AS forecast_budget_consumption,
    COALESCE(marginal.campaign_avg_roas, marginal.campaign_type_avg_roas) AS proxy_target_roas
  FROM marginal
  LEFT JOIN latest_campaign_attrs AS attrs
    ON attrs.date = marginal.date
    AND attrs.company = marginal.company
    AND attrs.campaign_id = marginal.campaign_id
)

SELECT
  date,
  company,
  campaign_id,
  campaign_name,
  campaign_type,
  status,
  bidding_strategy,
  current_cost,
  current_conversion_value,
  current_roas,
  marginal_roas,
  elasticity,
  impression_share,
  lost_is_budget,
  lost_is_rank,
  forecast_budget_consumption,
  proxy_target_roas,
  recommended_spend_band_min,
  recommended_spend_band_max,
  model_level_used,
  CASE
    WHEN marginal_roas IS NULL OR proxy_target_roas IS NULL THEN 'critical'
    WHEN marginal_roas < proxy_target_roas * 0.70 THEN 'critical'
    WHEN elasticity IS NOT NULL AND elasticity < 0 THEN 'critical'
    WHEN impression_share >= 0.90 THEN 'high'
    WHEN marginal_roas < proxy_target_roas THEN 'high'
    WHEN elasticity IS NOT NULL AND elasticity < 0.35 THEN 'high'
    WHEN impression_share >= 0.80 THEN 'moderate'
    WHEN lost_is_rank >= 0.50 THEN 'moderate'
    WHEN elasticity IS NOT NULL AND elasticity < 0.70 THEN 'moderate'
    ELSE 'low'
  END AS saturation_level,
  (impression_share >= 0.90) AS pure_budget_increase_blocked,
  CASE
    WHEN marginal_roas IS NULL OR proxy_target_roas IS NULL THEN 'missing_marginal_or_proxy_target'
    WHEN marginal_roas < proxy_target_roas * 0.70 THEN 'marginal_roas_far_below_proxy_target'
    WHEN elasticity IS NOT NULL AND elasticity < 0 THEN 'negative_elasticity'
    WHEN impression_share >= 0.90 THEN 'impression_share_above_90pct'
    WHEN marginal_roas < proxy_target_roas THEN 'marginal_roas_below_proxy_target'
    WHEN elasticity IS NOT NULL AND elasticity < 0.35 THEN 'low_elasticity'
    WHEN impression_share >= 0.80 THEN 'impression_share_above_80pct'
    WHEN lost_is_rank >= 0.50 THEN 'high_lost_is_rank'
    WHEN elasticity IS NOT NULL AND elasticity < 0.70 THEN 'moderate_elasticity'
    ELSE 'room_to_scale'
  END AS saturation_reason
FROM features;
