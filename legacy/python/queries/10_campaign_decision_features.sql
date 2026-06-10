-- GoTrends v2 - Sprint 7
-- Campaign lever diagnosis and prioritization scores.
--
-- Grain:
--   one row per company + campaign_id on the latest available campaign day.
--
-- Purpose:
--   combine daily performance, baseline, confidence, marginal ROAS, saturation,
--   and impression share into initial decision features.
--
-- Known limitations:
--   - target_roas/target_cpa are not available; proxy_target_roas uses historical ROAS.
--   - budget and forecast_budget_consumption are not available.
--   - search terms are not available; maintenance_score uses CTR/CVR/lost rank proxies.

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
  GROUP BY
    date,
    company,
    campaign_id
),

daily AS (
  SELECT
    ad_daily.*,
    clicks::numeric / NULLIF(impressions, 0) AS ctr,
    cost / NULLIF(clicks, 0) AS cpc,
    conversions / NULLIF(clicks, 0) AS cvr,
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

latest_attrs AS (
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
    SUM(conversion_value) OVER w7 / NULLIF(SUM(cost) OVER w7, 0) AS roas_7d,
    SUM(conversion_value) OVER w28 / NULLIF(SUM(cost) OVER w28, 0) AS roas_28d
  FROM daily
  WINDOW
    w7 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
    ),
    w28 AS (
      PARTITION BY company, campaign_id
      ORDER BY date
      ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
    )
),

latest_baseline AS (
  SELECT
    lookback.*,
    stddev_roas_28d / NULLIF(ABS(avg_roas_28d), 0) AS roas_cv_28d,
    CASE
      WHEN lookback.roas IS NULL OR lookback.roas_28d IS NULL THEN 'insufficient_data'
      WHEN lookback.roas > lookback.roas_28d * 1.35 THEN 'strong_positive'
      WHEN lookback.roas > lookback.roas_28d * 1.20 THEN 'positive'
      WHEN lookback.roas < lookback.roas_28d * 0.65 THEN 'strong_negative'
      WHEN lookback.roas < lookback.roas_28d * 0.80 THEN 'negative'
      ELSE 'normal'
    END AS trend_status
  FROM lookback
  JOIN latest_campaign_day AS latest
    ON latest.date = lookback.date
    AND latest.company = lookback.company
    AND latest.campaign_id = lookback.campaign_id
),

confidence AS (
  SELECT
    latest_baseline.*,
    CASE WHEN cost_28d >= 1000 THEN 25 ELSE 25 * COALESCE(cost_28d, 0) / 1000 END AS cost_score,
    CASE WHEN clicks_28d >= 500 THEN 25 ELSE 25 * COALESCE(clicks_28d, 0) / 500 END AS clicks_score,
    CASE WHEN conversions_28d >= 20 THEN 25 ELSE 25 * COALESCE(conversions_28d, 0) / 20 END AS conversions_score,
    CASE WHEN days_with_spend_28d >= 14 THEN 25 ELSE 25 * COALESCE(days_with_spend_28d, 0) / 14 END AS spend_days_score,
    CASE
      WHEN roas_observations_28d < 7 THEN 20
      WHEN roas_cv_28d IS NULL THEN 0
      WHEN roas_cv_28d <= 0.50 THEN 0
      WHEN roas_cv_28d >= 2.00 THEN 25
      ELSE (roas_cv_28d - 0.50) / 1.50 * 25
    END AS volatility_penalty
  FROM latest_baseline
),

confidence_scored AS (
  SELECT
    confidence.*,
    GREATEST(
      0,
      LEAST(
        100,
        ROUND(cost_score + clicks_score + conversions_score + spend_days_score - volatility_penalty, 0)
      )
    )::integer AS confidence_score
  FROM confidence
),

campaign_summary AS (
  SELECT
    company,
    campaign_id,
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
      FILTER (WHERE cost > 0 AND conversion_value > 0) AS campaign_type_elasticity,
    AVG(ctr) AS campaign_type_avg_ctr,
    AVG(cvr) AS campaign_type_avg_cvr,
    AVG(cpc) AS campaign_type_avg_cpc
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

campaign_target_band AS (
  SELECT DISTINCT ON (latest.company, latest.campaign_id)
    campaign_incremental.*
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
    campaign_incremental.spend_band
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

type_target_band AS (
  SELECT DISTINCT ON (latest.company, latest.campaign_id)
    latest.company AS source_company,
    latest.campaign_id AS source_campaign_id,
    type_incremental.*
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
    type_incremental.spend_band
),

features AS (
  SELECT
    confidence_scored.date,
    confidence_scored.company,
    confidence_scored.campaign_id,
    confidence_scored.campaign_name,
    confidence_scored.campaign_type,
    attrs.status,
    attrs.bidding_strategy,
    confidence_scored.cost AS current_cost,
    confidence_scored.impressions,
    confidence_scored.clicks,
    confidence_scored.conversions,
    confidence_scored.conversion_value,
    confidence_scored.ctr,
    confidence_scored.cpc,
    confidence_scored.cvr,
    confidence_scored.roas AS current_roas,
    confidence_scored.roas_7d,
    confidence_scored.roas_28d,
    confidence_scored.trend_status,
    confidence_scored.cost_28d,
    confidence_scored.clicks_28d,
    confidence_scored.conversions_28d,
    confidence_scored.confidence_score,
    attrs.impression_share,
    attrs.lost_is_budget,
    attrs.lost_is_rank,
    COALESCE(campaign_summary.campaign_avg_roas, type_summary.campaign_type_avg_roas) AS proxy_target_roas,
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
    CASE
      WHEN campaign_summary.days_with_spend >= 28
        AND campaign_summary.positive_revenue_days >= 14
        AND campaign_target_band.marginal_roas IS NOT NULL
      THEN 'campaign'
      ELSE 'campaign_type'
    END AS marginal_model_level,
    type_summary.campaign_type_avg_ctr,
    type_summary.campaign_type_avg_cvr,
    type_summary.campaign_type_avg_cpc
  FROM confidence_scored
  LEFT JOIN latest_attrs AS attrs
    ON attrs.date = confidence_scored.date
    AND attrs.company = confidence_scored.company
    AND attrs.campaign_id = confidence_scored.campaign_id
  LEFT JOIN campaign_summary
    ON campaign_summary.company = confidence_scored.company
    AND campaign_summary.campaign_id = confidence_scored.campaign_id
  LEFT JOIN type_summary
    ON type_summary.company = confidence_scored.company
    AND type_summary.campaign_type = confidence_scored.campaign_type
  LEFT JOIN campaign_target_band
    ON campaign_target_band.company = confidence_scored.company
    AND campaign_target_band.campaign_id = confidence_scored.campaign_id
  LEFT JOIN type_target_band
    ON type_target_band.source_company = confidence_scored.company
    AND type_target_band.source_campaign_id = confidence_scored.campaign_id
),

classified AS (
  SELECT
    features.*,
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
      WHEN current_roas >= proxy_target_roas AND COALESCE(impression_share, 0) >= 0.90 THEN 'saturated'
      WHEN current_roas >= proxy_target_roas AND COALESCE(lost_is_budget, 0) > 0.05 THEN 'budget_limited'
      WHEN current_roas >= proxy_target_roas AND marginal_roas >= proxy_target_roas THEN 'scale_opportunity'
      WHEN current_roas < proxy_target_roas AND current_cost > COALESCE(cost_28d, 0) / NULLIF(28, 0) THEN 'efficiency_risk'
      WHEN current_roas < proxy_target_roas THEN 'low_efficiency'
      WHEN ctr < campaign_type_avg_ctr * 0.70 THEN 'relevance_issue'
      WHEN cvr < campaign_type_avg_cvr * 0.70 THEN 'post_click_issue'
      ELSE 'monitor'
    END AS primary_constraint
  FROM features
),

scored AS (
  SELECT
    classified.*,
    LEAST(100, GREATEST(0, 50 * marginal_roas / NULLIF(proxy_target_roas, 0))) AS marginal_roas_score,
    LEAST(100, GREATEST(0, COALESCE(lost_is_budget, 0) * 100 + (1 - COALESCE(impression_share, 0.50)) * 50)) AS opportunity_score,
    LEAST(100, GREATEST(0, COALESCE(lost_is_budget, 0) * 100)) AS budget_limitation_score,
    CASE
      WHEN trend_status IN ('strong_positive', 'positive', 'normal') THEN 100
      WHEN trend_status = 'negative' THEN 50
      WHEN trend_status = 'strong_negative' THEN 0
      ELSE 40
    END AS stability_score,
    CASE
      WHEN current_roas IS NULL OR proxy_target_roas IS NULL THEN 50
      WHEN current_roas >= proxy_target_roas THEN 0
      ELSE LEAST(100, GREATEST(0, (1 - current_roas / NULLIF(proxy_target_roas, 0)) * 100))
    END AS roas_below_target_score,
    LEAST(100, GREATEST(0, current_cost / NULLIF(COALESCE(cost_28d, current_cost), 0) * 280)) AS wasted_spend_score,
    CASE
      WHEN trend_status = 'strong_negative' THEN 100
      WHEN trend_status = 'negative' THEN 70
      WHEN trend_status = 'normal' THEN 25
      ELSE 0
    END AS negative_trend_score,
    CASE saturation_level
      WHEN 'critical' THEN 100
      WHEN 'high' THEN 75
      WHEN 'moderate' THEN 40
      ELSE 10
    END AS saturation_score,
    LEAST(100, GREATEST(0,
      COALESCE(lost_is_rank, 0) * 70
      + CASE WHEN ctr < campaign_type_avg_ctr * 0.70 THEN 30 ELSE 0 END
      + CASE WHEN cvr < campaign_type_avg_cvr * 0.70 THEN 30 ELSE 0 END
      + CASE WHEN cpc > campaign_type_avg_cpc * 1.30 THEN 20 ELSE 0 END
    )) AS maintenance_score
  FROM classified
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
  impressions,
  clicks,
  conversions,
  conversion_value,
  ctr,
  cpc,
  cvr,
  current_roas,
  proxy_target_roas,
  marginal_roas,
  elasticity,
  saturation_level,
  pure_budget_increase_blocked,
  confidence_score,
  trend_status,
  impression_share,
  lost_is_budget,
  lost_is_rank,
  recommended_spend_band_min,
  recommended_spend_band_max,
  marginal_model_level,
  primary_constraint,
  CASE
    WHEN primary_constraint = 'budget_limited' AND NOT pure_budget_increase_blocked THEN 'increase_budget'
    WHEN primary_constraint = 'scale_opportunity' AND saturation_level IN ('low', 'moderate') THEN 'increase_budget'
    WHEN primary_constraint IN ('efficiency_risk', 'low_efficiency') THEN 'increase_troas_or_reduce_budget'
    WHEN primary_constraint = 'saturated' THEN 'optimize_efficiency'
    WHEN primary_constraint = 'relevance_issue' THEN 'improve_ads_or_terms'
    WHEN primary_constraint = 'post_click_issue' THEN 'review_landing_or_offer'
    ELSE 'monitor'
  END AS best_lever,
  CASE
    WHEN primary_constraint IN ('budget_limited', 'scale_opportunity') THEN 'decrease_troas'
    WHEN primary_constraint IN ('efficiency_risk', 'low_efficiency') THEN 'increase_budget'
    WHEN primary_constraint = 'saturated' THEN 'pure_budget_increase'
    ELSE NULL
  END AS avoid_lever,
  ROUND(
    0.30 * marginal_roas_score
    + 0.25 * opportunity_score
    + 0.20 * budget_limitation_score
    + 0.15 * confidence_score
    + 0.10 * stability_score,
    0
  )::integer AS scale_score,
  ROUND(
    0.35 * roas_below_target_score
    + 0.25 * wasted_spend_score
    + 0.20 * negative_trend_score
    + 0.10 * saturation_score
    + 0.10 * confidence_score,
    0
  )::integer AS efficiency_risk_score,
  ROUND(maintenance_score, 0)::integer AS maintenance_score,
  CASE
    WHEN confidence_score < 40 THEN 'monitor'
    WHEN pure_budget_increase_blocked AND primary_constraint IN ('budget_limited', 'scale_opportunity') THEN 'optimize_efficiency'
    WHEN primary_constraint IN ('budget_limited', 'scale_opportunity')
      AND saturation_level IN ('low', 'moderate')
      AND confidence_score >= 60
    THEN 'increase_budget'
    WHEN primary_constraint IN ('efficiency_risk', 'low_efficiency')
      AND confidence_score >= 60
    THEN 'increase_troas_or_reduce_budget'
    WHEN primary_constraint = 'saturated' THEN 'optimize_efficiency'
    WHEN primary_constraint = 'relevance_issue' THEN 'improve_ads_or_terms'
    WHEN primary_constraint = 'post_click_issue' THEN 'review_landing_or_offer'
    ELSE 'monitor'
  END AS recommended_action,
  CASE
    WHEN confidence_score < 40 THEN 'high'
    WHEN saturation_level IN ('critical', 'high') THEN 'high'
    WHEN confidence_score < 60 OR saturation_level = 'moderate' THEN 'medium'
    ELSE 'low'
  END AS risk_level,
  CONCAT(
    'constraint=', primary_constraint,
    '; saturation=', saturation_level,
    '; confidence=', confidence_score,
    '; trend=', trend_status,
    '; marginal_roas=', ROUND(marginal_roas, 2),
    '; proxy_target_roas=', ROUND(proxy_target_roas, 2)
  ) AS reason
FROM scored;
