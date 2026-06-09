-- GoTrends v2 - Sprint 5
-- Spend bands for marginal elasticity.
--
-- Grain:
--   one row per spend band, at campaign level and campaign_type fallback level.
--
-- Method:
--   - Build daily campaign metrics from ad-level data.
--   - Keep days with positive cost.
--   - Split historical daily spend into 4 spend bands with NTILE.
--   - Compute average cost, revenue, average ROAS, and marginal ROAS by band.
--
-- Notes:
--   - Band 1 has no previous band, so marginal_roas is NULL by design.
--   - Use model_level = 'campaign' first; use 'campaign_type' as fallback.

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
)

SELECT
  model_level,
  company,
  campaign_id,
  campaign_name,
  campaign_type,
  spend_band,
  days_in_band,
  spend_band_min,
  spend_band_max,
  avg_cost,
  avg_conversion_value,
  avg_roas,
  incremental_cost,
  incremental_conversion_value,
  marginal_roas
FROM campaign_incremental

UNION ALL

SELECT
  model_level,
  company,
  campaign_id,
  campaign_name,
  campaign_type,
  spend_band,
  days_in_band,
  spend_band_min,
  spend_band_max,
  avg_cost,
  avg_conversion_value,
  avg_roas,
  incremental_cost,
  incremental_conversion_value,
  marginal_roas
FROM type_incremental;
