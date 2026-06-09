-- GoTrends v2 - Sprint 5
-- Marginal ROAS and elasticity features for the latest available day.
--
-- Grain:
--   one row per company + campaign_id on the latest available date.
--
-- Method:
--   - Build daily campaign metrics from ad-level data.
--   - Build spend bands by campaign and by campaign_type fallback.
--   - Estimate elasticity with log-log regression:
--       ln(conversion_value) = alpha + beta * ln(cost)
--   - Use campaign-level estimates when enough history exists, otherwise
--     fallback to campaign_type estimates.
--
-- Current MVP thresholds:
--   campaign-level model is used when:
--     days_with_spend >= 28
--     positive_revenue_days >= 14
--     campaign marginal_roas is available

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

campaign_summary AS (
  SELECT
    company,
    campaign_id,
    MAX(campaign_name) AS campaign_name,
    MAX(campaign_type) AS campaign_type,
    COUNT(*) AS days_with_spend,
    COUNT(*) FILTER (WHERE conversion_value > 0) AS positive_revenue_days,
    AVG(cost) AS avg_cost,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS avg_roas,
    regr_slope(LN(conversion_value::double precision), LN(cost::double precision))
      FILTER (WHERE cost > 0 AND conversion_value > 0) AS elasticity
  FROM daily
  GROUP BY
    company,
    campaign_id
),

type_summary AS (
  SELECT
    company,
    campaign_type,
    COUNT(*) AS type_days_with_spend,
    COUNT(*) FILTER (WHERE conversion_value > 0) AS type_positive_revenue_days,
    AVG(cost) AS type_avg_cost,
    SUM(conversion_value) / NULLIF(SUM(cost), 0) AS type_avg_roas,
    regr_slope(LN(conversion_value::double precision), LN(cost::double precision))
      FILTER (WHERE cost > 0 AND conversion_value > 0) AS type_elasticity
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
    'campaign'::text AS model_level,
    company,
    campaign_id,
    MAX(campaign_name) AS campaign_name,
    MAX(campaign_type) AS campaign_type,
    spend_band,
    COUNT(*) AS days_in_band,
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
    avg_cost - LAG(avg_cost) OVER w AS incremental_cost,
    avg_conversion_value - LAG(avg_conversion_value) OVER w AS incremental_conversion_value,
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
    'campaign_type'::text AS model_level,
    company,
    NULL::bigint AS campaign_id,
    NULL::text AS campaign_name,
    campaign_type,
    spend_band,
    COUNT(*) AS days_in_band,
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
    avg_cost - LAG(avg_cost) OVER w AS incremental_cost,
    avg_conversion_value - LAG(avg_conversion_value) OVER w AS incremental_conversion_value,
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
)

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
      THEN campaign_summary.elasticity
    END,
    type_summary.type_elasticity
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
  campaign_summary.avg_roas AS campaign_avg_roas,
  type_summary.type_avg_roas AS campaign_type_avg_roas,
  campaign_summary.elasticity AS campaign_elasticity,
  type_summary.type_elasticity AS campaign_type_elasticity
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
  AND type_target_band.source_campaign_id = latest.campaign_id;
