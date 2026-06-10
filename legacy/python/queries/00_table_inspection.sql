-- GoTrends v2 - Sprint 0 table inspection
-- Source database in Metabase: Data Mart
-- Main source table: raw.gogroup_google_ads
-- Auxiliary campaign table: raw.gogroup_google_ads_campaigns
-- Auxiliary keyword table: raw.gogroup_google_ads_keywords

-- 1) Main table shape and date coverage.
SELECT
  COUNT(*) AS row_count,
  MIN(date) AS min_date,
  MAX(date) AS max_date,
  COUNT(DISTINCT date) AS distinct_dates,
  COUNT(DISTINCT campaign_id) AS distinct_campaigns,
  COUNT(DISTINCT ad_group_id) AS distinct_ad_groups,
  COUNT(DISTINCT ad_id) AS distinct_ads,
  COUNT(*) FILTER (WHERE cost < 0) AS negative_cost_rows,
  COUNT(*) FILTER (WHERE clicks > impressions) AS clicks_gt_impressions_rows
FROM raw.gogroup_google_ads;

-- 2) Granularity check for the main table.
WITH keys AS (
  SELECT
    date,
    company,
    campaign_id,
    ad_group_id,
    ad_id,
    COUNT(*) AS rows_per_key
  FROM raw.gogroup_google_ads
  GROUP BY 1, 2, 3, 4, 5
)
SELECT
  COUNT(*) AS unique_daily_ad_keys,
  SUM(rows_per_key) AS row_count,
  COUNT(*) FILTER (WHERE rows_per_key > 1) AS duplicated_keys,
  MAX(rows_per_key) AS max_rows_per_key
FROM keys;

-- 3) Null checks for the fields needed by the MVP campaign layer.
SELECT
  COUNT(*) FILTER (WHERE date IS NULL) AS null_date,
  COUNT(*) FILTER (WHERE campaign_id IS NULL) AS null_campaign_id,
  COUNT(*) FILTER (WHERE campaign_name IS NULL OR campaign_name = '') AS null_campaign_name,
  COUNT(*) FILTER (WHERE ad_group_id IS NULL) AS null_ad_group_id,
  COUNT(*) FILTER (WHERE ad_id IS NULL) AS null_ad_id,
  COUNT(*) FILTER (WHERE cost IS NULL) AS null_cost,
  COUNT(*) FILTER (WHERE revenue IS NULL) AS null_revenue,
  COUNT(*) FILTER (WHERE conversions IS NULL) AS null_conversions,
  COUNT(*) FILTER (WHERE impressions IS NULL) AS null_impressions,
  COUNT(*) FILTER (WHERE clicks IS NULL) AS null_clicks
FROM raw.gogroup_google_ads;

-- 4) Sample rows from the main table.
SELECT
  date,
  company,
  campaign_id,
  campaign_name,
  channel_type,
  ad_group_id,
  ad_group_name,
  ad_id,
  cost,
  revenue,
  impressions,
  clicks,
  conversions
FROM raw.gogroup_google_ads
ORDER BY date DESC, cost DESC
LIMIT 20;

-- 5) Campaign-level auxiliary table coverage.
SELECT
  COUNT(*) AS row_count,
  MIN(date) AS min_date,
  MAX(date) AS max_date,
  COUNT(DISTINCT date) AS distinct_dates,
  COUNT(DISTINCT campaign_id) AS distinct_campaigns,
  COUNT(DISTINCT campaign_status) AS distinct_statuses,
  COUNT(DISTINCT bidding_strategy_type) AS distinct_bidding_strategies,
  COUNT(*) FILTER (WHERE search_impression_share IS NOT NULL) AS rows_with_impression_share,
  COUNT(*) FILTER (WHERE search_budget_lost_impression_share IS NOT NULL) AS rows_with_lost_is_budget,
  COUNT(*) FILTER (WHERE search_rank_lost_impression_share IS NOT NULL) AS rows_with_lost_is_rank
FROM raw.gogroup_google_ads_campaigns;

-- 6) Campaign-level statuses, bidding strategies, and channel types.
SELECT 'status' AS field, campaign_status AS value, COUNT(*) AS rows
FROM raw.gogroup_google_ads_campaigns
GROUP BY 1, 2
UNION ALL
SELECT 'bidding_strategy_type', bidding_strategy_type, COUNT(*)
FROM raw.gogroup_google_ads_campaigns
GROUP BY 1, 2
UNION ALL
SELECT 'channel_type', channel_type, COUNT(*)
FROM raw.gogroup_google_ads_campaigns
GROUP BY 1, 2
ORDER BY field, rows DESC;

-- 7) Inspect all raw GoGroup Google Ads table columns.
SELECT
  table_schema,
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'raw'
  AND table_name IN (
    'gogroup_google_ads',
    'gogroup_google_ads_campaigns',
    'gogroup_google_ads_keywords',
    'dados_google_ads_gogroup'
  )
ORDER BY table_name, ordinal_position;
