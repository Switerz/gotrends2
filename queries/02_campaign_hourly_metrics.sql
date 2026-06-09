-- GoTrends v2 - Sprint 1
-- campaign_hourly_metrics
--
-- Status: PENDING
--
-- Sprint 0 confirmed that raw.gogroup_google_ads does not contain an hour
-- field. created_at and updated_at are load/update timestamps, not performance
-- timestamps. Because of that, an actual hourly campaign metrics layer cannot
-- be built from the current source without inventing data.
--
-- This placeholder preserves the expected schema and makes the blocker
-- explicit. Replace it when a real hourly Google Ads performance source is
-- identified.

SELECT
  NULL::date AS date,
  NULL::integer AS hour,
  NULL::text AS company,
  NULL::bigint AS campaign_id,
  NULL::text AS campaign_name,
  NULL::text AS campaign_type,
  NULL::numeric AS cost,
  NULL::bigint AS impressions,
  NULL::bigint AS clicks,
  NULL::numeric AS conversions,
  NULL::numeric AS conversion_value,
  NULL::numeric AS revenue_real
WHERE FALSE;
