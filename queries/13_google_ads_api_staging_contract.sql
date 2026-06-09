-- GoTrends v2 - Google Ads API staging contract
--
-- Purpose:
--   Define the staging shape produced by tools/export_apice_google_ads.py and
--   used to replace proxy budget, target_roas, target_cpa and intraday fields.
--   The daily layer also joins GA4 purchase_revenue for business ROAS.
--
-- This file is a contract/template. Do not run it against production before
-- choosing the final schema name and load mechanism.

-- Expected staging table: staging.google_ads_campaign_settings
--
-- customer_id text
-- company text
-- campaign_id bigint
-- campaign_name text
-- campaign_status text
-- bidding_strategy_type text
-- campaign_budget_resource text
-- budget_amount_micros bigint
-- budget_brl numeric
-- budget_period text
-- budget_status text
-- target_roas numeric
-- target_cpa_micros bigint
-- target_cpa_brl numeric

-- Expected staging table: staging.google_ads_hourly_metrics
--
-- customer_id text
-- company text
-- campaign_id bigint
-- campaign_name text
-- campaign_status text
-- date date
-- hour integer
-- cost_micros bigint
-- cost_brl numeric
-- impressions bigint
-- clicks bigint
-- conversions numeric
-- conversion_value numeric

WITH campaign_daily AS (
  SELECT
    ads.date,
    ads.company,
    ads.campaign_id,
    MAX(ads.campaign_name) AS campaign_name,
    MAX(ads.channel_type) AS campaign_type,
    SUM(ads.cost)::numeric AS cost,
    SUM(ads.impressions)::bigint AS impressions,
    SUM(ads.clicks)::bigint AS clicks,
    SUM(ads.conversions)::numeric AS conversions,
    SUM(ads.revenue)::numeric AS ads_conversion_value
  FROM raw.gogroup_google_ads AS ads
  GROUP BY 1, 2, 3
),

ga4_daily AS (
  SELECT
    ga4.date::date AS date,
    ga4.company,
    LOWER(TRIM(ga4.campaign)) AS campaign_key,
    SUM(ga4.purchase_revenue)::numeric AS ga4_purchase_revenue,
    SUM(ga4.transactions)::numeric AS ga4_transactions,
    SUM(ga4.sessions)::bigint AS ga4_sessions
  FROM raw.ga4_gogroup_all_channels AS ga4
  WHERE LOWER(ga4.source) = 'google'
    AND LOWER(ga4.medium) = 'cpc'
  GROUP BY 1, 2, 3
),

campaign_settings AS (
  SELECT
    settings.company,
    settings.campaign_id,
    settings.campaign_status,
    settings.bidding_strategy_type,
    settings.budget_brl AS budget,
    NULLIF(settings.target_roas, 0) AS target_roas,
    NULLIF(settings.target_cpa_brl, 0) AS target_cpa
  FROM staging.google_ads_campaign_settings AS settings
),

daily_enriched AS (
  SELECT
    campaign_daily.date,
    campaign_daily.company,
    campaign_daily.campaign_id,
    campaign_daily.campaign_name,
    campaign_daily.campaign_type,
    COALESCE(campaign_settings.campaign_status, 'UNKNOWN') AS status,
    campaign_settings.bidding_strategy_type AS bidding_strategy,
    campaign_daily.cost,
    campaign_daily.impressions,
    campaign_daily.clicks,
    campaign_daily.conversions,
    campaign_daily.ads_conversion_value AS conversion_value,
    campaign_daily.ads_conversion_value,
    COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric AS ga4_purchase_revenue,
    COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric AS business_revenue,
    COALESCE(ga4_daily.ga4_transactions, 0)::numeric AS ga4_transactions,
    COALESCE(ga4_daily.ga4_sessions, 0)::bigint AS ga4_sessions,
    CASE WHEN ga4_daily.campaign_key IS NULL THEN 'missing' ELSE 'ga4_google_cpc_campaign_name' END AS ga4_revenue_source,
    campaign_settings.budget,
    campaign_settings.target_roas,
    campaign_settings.target_cpa,
    campaign_daily.cost / NULLIF(campaign_settings.budget, 0) AS budget_consumption,
    campaign_daily.clicks::numeric / NULLIF(campaign_daily.impressions, 0) AS ctr,
    campaign_daily.cost / NULLIF(campaign_daily.clicks, 0) AS cpc,
    campaign_daily.conversions / NULLIF(campaign_daily.clicks, 0) AS cvr,
    campaign_daily.ads_conversion_value / NULLIF(campaign_daily.cost, 0) AS ads_roas,
    COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric / NULLIF(campaign_daily.cost, 0) AS ga4_roas,
    COALESCE(ga4_daily.ga4_purchase_revenue, 0)::numeric / NULLIF(campaign_daily.cost, 0) AS roas
  FROM campaign_daily
  LEFT JOIN ga4_daily
    ON ga4_daily.date = campaign_daily.date
    AND LOWER(ga4_daily.company) = LOWER(campaign_daily.company)
    AND ga4_daily.campaign_key = LOWER(TRIM(campaign_daily.campaign_name))
  LEFT JOIN campaign_settings
    ON LOWER(campaign_settings.company) = LOWER(campaign_daily.company)
    AND campaign_settings.campaign_id = campaign_daily.campaign_id
),

hourly_metrics AS (
  SELECT
    hourly.date,
    hourly.hour,
    hourly.company,
    hourly.campaign_id,
    hourly.campaign_name,
    hourly.campaign_status AS status,
    hourly.cost_brl AS cost,
    hourly.impressions,
    hourly.clicks,
    hourly.conversions,
    hourly.conversion_value,
    settings.budget_brl AS budget,
    NULLIF(settings.target_roas, 0) AS target_roas,
    NULLIF(settings.target_cpa_brl, 0) AS target_cpa,
    hourly.cost_brl / NULLIF(settings.budget_brl, 0) AS budget_consumption,
    hourly.clicks::numeric / NULLIF(hourly.impressions, 0) AS ctr,
    hourly.cost_brl / NULLIF(hourly.clicks, 0) AS cpc,
    hourly.conversions / NULLIF(hourly.clicks, 0) AS cvr,
    hourly.conversion_value / NULLIF(hourly.cost_brl, 0) AS roas
  FROM staging.google_ads_hourly_metrics AS hourly
  LEFT JOIN staging.google_ads_campaign_settings AS settings
    ON LOWER(settings.company) = LOWER(hourly.company)
    AND settings.campaign_id = hourly.campaign_id
)

SELECT
  'daily_enriched' AS layer_name,
  COUNT(*) AS rows,
  COUNT(*) FILTER (WHERE budget IS NOT NULL) AS rows_with_budget,
  COUNT(*) FILTER (WHERE target_roas IS NOT NULL) AS rows_with_target_roas,
  COUNT(*) FILTER (WHERE target_cpa IS NOT NULL) AS rows_with_target_cpa
FROM daily_enriched

UNION ALL

SELECT
  'hourly_metrics' AS layer_name,
  COUNT(*) AS rows,
  COUNT(*) FILTER (WHERE budget IS NOT NULL) AS rows_with_budget,
  COUNT(*) FILTER (WHERE target_roas IS NOT NULL) AS rows_with_target_roas,
  COUNT(*) FILTER (WHERE target_cpa IS NOT NULL) AS rows_with_target_cpa
FROM hourly_metrics;
