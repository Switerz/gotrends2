-- GoTrends v2 - Sprint 1
-- campaign_daily_metrics
--
-- Grain:
--   one row per date + company + campaign_id
--
-- Sources:
--   raw.gogroup_google_ads           -> daily ad-level performance
--   raw.gogroup_google_ads_campaigns -> campaign status, bidding strategy, impression share
--
-- Notes:
--   - raw.gogroup_google_ads has no budget, target_roas, or target_cpa.
--   - revenue is used as both conversion_value and revenue_real until a separate
--     real revenue source is confirmed.
--   - All ratios use NULLIF to avoid division by zero.

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
    SUM(revenue)::numeric AS revenue_real,
    COUNT(*) AS source_ad_rows,
    COUNT(DISTINCT ad_group_id) AS ad_groups,
    COUNT(DISTINCT ad_id) AS ads
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
    bidding_strategy_type AS bidding_strategy,
    search_impression_share::numeric AS impression_share,
    search_budget_lost_impression_share::numeric AS lost_is_budget,
    search_rank_lost_impression_share::numeric AS lost_is_rank
  FROM raw.gogroup_google_ads_campaigns
)

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
  NULL::numeric AS budget,
  NULL::numeric AS target_roas,
  NULL::numeric AS target_cpa,
  campaign_attrs.impression_share,
  campaign_attrs.lost_is_budget,
  campaign_attrs.lost_is_rank,
  ad_daily.clicks::numeric / NULLIF(ad_daily.impressions, 0) AS ctr,
  ad_daily.cost / NULLIF(ad_daily.clicks, 0) AS cpc,
  ad_daily.conversions / NULLIF(ad_daily.clicks, 0) AS cvr,
  ad_daily.conversion_value / NULLIF(ad_daily.cost, 0) AS roas,
  NULL::numeric AS budget_consumption,
  ad_daily.source_ad_rows,
  ad_daily.ad_groups,
  ad_daily.ads
FROM ad_daily
LEFT JOIN campaign_attrs
  ON campaign_attrs.date = ad_daily.date
  AND campaign_attrs.company = ad_daily.company
  AND campaign_attrs.campaign_id = ad_daily.campaign_id;

-- Validation queries for Sprint 1.
-- Run these against the CTE above after creating a view/table, or wrap the
-- SELECT above as campaign_daily_metrics in Metabase.
--
-- SELECT
--   COUNT(*) AS rows,
--   COUNT(*) FILTER (WHERE cost < 0) AS negative_cost_rows,
--   COUNT(*) FILTER (WHERE clicks > impressions) AS clicks_gt_impressions_rows,
--   COUNT(*) FILTER (WHERE cost = 0 AND roas IS NOT NULL) AS roas_should_be_null_rows,
--   COUNT(*) FILTER (WHERE date IS NULL) AS null_date_rows
-- FROM campaign_daily_metrics;
