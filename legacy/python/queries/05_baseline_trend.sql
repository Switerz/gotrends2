-- GoTrends v2 - Sprint 3
-- Baseline, trend, and simple anomaly features.
--
-- Grain:
--   one row per date + company + campaign_id
--
-- Sources:
--   raw.gogroup_google_ads
--   raw.gogroup_google_ads_campaigns
--
-- Method:
--   - Build the same daily campaign layer from Sprint 1.
--   - Compute trailing 7d, 14d, and 28d baselines using prior days only.
--   - Compute same-weekday baseline using previous occurrences of that weekday.
--   - Compute an EWMA-style ROAS approximation from recent lags with alpha = 0.4.
--   - Flag simple anomalies with robust z-score using median/MAD over previous 28 days.

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
    bidding_strategy_type AS bidding_strategy,
    search_impression_share::numeric AS impression_share,
    search_budget_lost_impression_share::numeric AS lost_is_budget,
    search_rank_lost_impression_share::numeric AS lost_is_rank
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
    campaign_attrs.impression_share,
    campaign_attrs.lost_is_budget,
    campaign_attrs.lost_is_rank,
    ad_daily.clicks::numeric / NULLIF(ad_daily.impressions, 0) AS ctr,
    ad_daily.cost / NULLIF(ad_daily.clicks, 0) AS cpc,
    ad_daily.conversions / NULLIF(ad_daily.clicks, 0) AS cvr,
    ad_daily.conversion_value / NULLIF(ad_daily.cost, 0) AS roas,
    EXTRACT(DOW FROM ad_daily.date)::integer AS weekday
  FROM ad_daily
  LEFT JOIN campaign_attrs
    ON campaign_attrs.date = ad_daily.date
    AND campaign_attrs.company = ad_daily.company
    AND campaign_attrs.campaign_id = ad_daily.campaign_id
),

rolling AS (
  SELECT
    daily.*,
    SUM(cost) OVER w7 AS cost_7d,
    SUM(cost) OVER w14 AS cost_14d,
    SUM(cost) OVER w28 AS cost_28d,
    SUM(clicks) OVER w28 AS clicks_28d,
    SUM(conversions) OVER w28 AS conversions_28d,
    SUM(conversion_value) OVER w7 AS conversion_value_7d,
    SUM(conversion_value) OVER w14 AS conversion_value_14d,
    SUM(conversion_value) OVER w28 AS conversion_value_28d,
    SUM(conversion_value) OVER w7 / NULLIF(SUM(cost) OVER w7, 0) AS roas_7d,
    SUM(conversion_value) OVER w14 / NULLIF(SUM(cost) OVER w14, 0) AS roas_14d,
    SUM(conversion_value) OVER w28 / NULLIF(SUM(cost) OVER w28, 0) AS roas_28d
  FROM daily
  WINDOW
    w7 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
    ),
    w14 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 14 PRECEDING AND 1 PRECEDING
    ),
    w28 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
    )
),

same_weekday AS (
  SELECT
    rolling.*,
    SUM(conversion_value) OVER w_same_weekday
      / NULLIF(SUM(cost) OVER w_same_weekday, 0) AS same_weekday_roas
  FROM rolling
  WINDOW
    w_same_weekday AS (
      PARTITION BY company, campaign_id, weekday
      ORDER BY date
      ROWS BETWEEN 8 PRECEDING AND 1 PRECEDING
    )
),

lagged AS (
  SELECT
    same_weekday.*,
    LAG(roas, 1) OVER w AS roas_lag_1,
    LAG(roas, 2) OVER w AS roas_lag_2,
    LAG(roas, 3) OVER w AS roas_lag_3,
    LAG(roas, 4) OVER w AS roas_lag_4,
    LAG(roas, 5) OVER w AS roas_lag_5,
    LAG(roas, 6) OVER w AS roas_lag_6,
    LAG(roas, 7) OVER w AS roas_lag_7
  FROM same_weekday
  WINDOW w AS (PARTITION BY company, campaign_id ORDER BY date)
),

ewma AS (
  SELECT
    lagged.*,
    (
      0.400000 * COALESCE(roas_lag_1, 0)
      + 0.240000 * COALESCE(roas_lag_2, 0)
      + 0.144000 * COALESCE(roas_lag_3, 0)
      + 0.086400 * COALESCE(roas_lag_4, 0)
      + 0.051840 * COALESCE(roas_lag_5, 0)
      + 0.031104 * COALESCE(roas_lag_6, 0)
      + 0.018662 * COALESCE(roas_lag_7, 0)
    )
    / NULLIF(
      CASE WHEN roas_lag_1 IS NULL THEN 0 ELSE 0.400000 END
      + CASE WHEN roas_lag_2 IS NULL THEN 0 ELSE 0.240000 END
      + CASE WHEN roas_lag_3 IS NULL THEN 0 ELSE 0.144000 END
      + CASE WHEN roas_lag_4 IS NULL THEN 0 ELSE 0.086400 END
      + CASE WHEN roas_lag_5 IS NULL THEN 0 ELSE 0.051840 END
      + CASE WHEN roas_lag_6 IS NULL THEN 0 ELSE 0.031104 END
      + CASE WHEN roas_lag_7 IS NULL THEN 0 ELSE 0.018662 END,
      0
    ) AS ewma_roas
  FROM lagged
),

metric_values AS (
  SELECT
    ewma.company,
    ewma.campaign_id,
    ewma.date,
    stats.metric,
    stats.metric_value
  FROM ewma
  CROSS JOIN LATERAL (
    VALUES
      ('cpc', ewma.cpc),
      ('ctr', ewma.ctr),
      ('cvr', ewma.cvr),
      ('roas', ewma.roas),
      ('cost', ewma.cost),
      ('conversions', ewma.conversions)
  ) AS stats(metric, metric_value)
  WHERE stats.metric_value IS NOT NULL
),

anomaly_medians AS (
  SELECT
    current_metric.company,
    current_metric.campaign_id,
    current_metric.date,
    current_metric.metric,
    current_metric.metric_value,
    COUNT(history_metric.metric_value) AS history_points,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY history_metric.metric_value
    ) AS median_value
  FROM metric_values AS current_metric
  LEFT JOIN metric_values AS history_metric
    ON history_metric.company = current_metric.company
    AND history_metric.campaign_id = current_metric.campaign_id
    AND history_metric.metric = current_metric.metric
    AND history_metric.date >= current_metric.date - INTERVAL '28 days'
    AND history_metric.date < current_metric.date
  GROUP BY
    current_metric.company,
    current_metric.campaign_id,
    current_metric.date,
    current_metric.metric,
    current_metric.metric_value
),

anomaly_stats AS (
  SELECT
    anomaly_medians.company,
    anomaly_medians.campaign_id,
    anomaly_medians.date,
    anomaly_medians.metric,
    anomaly_medians.metric_value,
    anomaly_medians.history_points,
    anomaly_medians.median_value,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY ABS(history_metric.metric_value - anomaly_medians.median_value)
    ) AS mad_value
  FROM anomaly_medians
  LEFT JOIN metric_values AS history_metric
    ON history_metric.company = anomaly_medians.company
    AND history_metric.campaign_id = anomaly_medians.campaign_id
    AND history_metric.metric = anomaly_medians.metric
    AND history_metric.date >= anomaly_medians.date - INTERVAL '28 days'
    AND history_metric.date < anomaly_medians.date
  GROUP BY
    anomaly_medians.company,
    anomaly_medians.campaign_id,
    anomaly_medians.date,
    anomaly_medians.metric,
    anomaly_medians.metric_value,
    anomaly_medians.history_points,
    anomaly_medians.median_value
),

anomaly_flags AS (
  SELECT
    company,
    campaign_id,
    date,
    MAX(
      CASE
        WHEN metric = 'cpc'
          AND history_points >= 7
          AND mad_value > 0
          AND ABS(0.6745 * (metric_value - median_value) / mad_value) >= 3.5
        THEN 1 ELSE 0
      END
    ) AS cpc_anomaly,
    MAX(
      CASE
        WHEN metric = 'ctr'
          AND history_points >= 7
          AND mad_value > 0
          AND ABS(0.6745 * (metric_value - median_value) / mad_value) >= 3.5
        THEN 1 ELSE 0
      END
    ) AS ctr_anomaly,
    MAX(
      CASE
        WHEN metric = 'cvr'
          AND history_points >= 7
          AND mad_value > 0
          AND ABS(0.6745 * (metric_value - median_value) / mad_value) >= 3.5
        THEN 1 ELSE 0
      END
    ) AS cvr_anomaly,
    MAX(
      CASE
        WHEN metric = 'roas'
          AND history_points >= 7
          AND mad_value > 0
          AND ABS(0.6745 * (metric_value - median_value) / mad_value) >= 3.5
        THEN 1 ELSE 0
      END
    ) AS roas_anomaly,
    MAX(
      CASE
        WHEN metric = 'cost'
          AND history_points >= 7
          AND mad_value > 0
          AND ABS(0.6745 * (metric_value - median_value) / mad_value) >= 3.5
        THEN 1 ELSE 0
      END
    ) AS cost_anomaly,
    MAX(
      CASE
        WHEN metric = 'conversions'
          AND history_points >= 7
          AND mad_value > 0
          AND ABS(0.6745 * (metric_value - median_value) / mad_value) >= 3.5
        THEN 1 ELSE 0
      END
    ) AS conversions_anomaly
  FROM anomaly_stats
  GROUP BY
    company,
    campaign_id,
    date
)

SELECT
  ewma.date,
  ewma.company,
  ewma.campaign_id,
  ewma.campaign_name,
  ewma.campaign_type,
  ewma.status,
  ewma.bidding_strategy,
  ewma.cost,
  ewma.impressions,
  ewma.clicks,
  ewma.conversions,
  ewma.conversion_value,
  ewma.revenue_real,
  ewma.ctr,
  ewma.cpc,
  ewma.cvr,
  ewma.roas,
  ewma.cost_7d,
  ewma.cost_14d,
  ewma.cost_28d,
  ewma.clicks_28d,
  ewma.conversions_28d,
  ewma.conversion_value_7d,
  ewma.conversion_value_14d,
  ewma.conversion_value_28d,
  ewma.roas_7d,
  ewma.roas_14d,
  ewma.roas_28d,
  ewma.same_weekday_roas,
  ewma.ewma_roas,
  CASE
    WHEN ewma.roas IS NULL OR ewma.roas_28d IS NULL THEN 'insufficient_data'
    WHEN ewma.roas > ewma.roas_28d * 1.35 THEN 'strong_positive'
    WHEN ewma.roas > ewma.roas_28d * 1.20 THEN 'positive'
    WHEN ewma.roas < ewma.roas_28d * 0.65 THEN 'strong_negative'
    WHEN ewma.roas < ewma.roas_28d * 0.80 THEN 'negative'
    ELSE 'normal'
  END AS trend_status,
  COALESCE(anomaly_flags.cpc_anomaly, 0)::boolean AS cpc_anomaly,
  COALESCE(anomaly_flags.ctr_anomaly, 0)::boolean AS ctr_anomaly,
  COALESCE(anomaly_flags.cvr_anomaly, 0)::boolean AS cvr_anomaly,
  COALESCE(anomaly_flags.roas_anomaly, 0)::boolean AS roas_anomaly,
  COALESCE(anomaly_flags.cost_anomaly, 0)::boolean AS cost_anomaly,
  COALESCE(anomaly_flags.conversions_anomaly, 0)::boolean AS conversions_anomaly,
  (
    COALESCE(anomaly_flags.cpc_anomaly, 0)
    + COALESCE(anomaly_flags.ctr_anomaly, 0)
    + COALESCE(anomaly_flags.cvr_anomaly, 0)
    + COALESCE(anomaly_flags.roas_anomaly, 0)
    + COALESCE(anomaly_flags.cost_anomaly, 0)
    + COALESCE(anomaly_flags.conversions_anomaly, 0)
  ) AS anomaly_count,
  (
    COALESCE(anomaly_flags.roas_anomaly, 0) = 1
    OR COALESCE(anomaly_flags.cost_anomaly, 0) = 1
    OR COALESCE(anomaly_flags.conversions_anomaly, 0) = 1
  ) AS critical_anomaly_block
FROM ewma
LEFT JOIN anomaly_flags
  ON anomaly_flags.company = ewma.company
  AND anomaly_flags.campaign_id = ewma.campaign_id
  AND anomaly_flags.date = ewma.date;
