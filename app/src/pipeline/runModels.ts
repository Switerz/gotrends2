// src/pipeline/runModels.ts
//
// Daily-cron entry point. For a single account:
//   1. Open a `model_runs` row (status='running').
//   2. Fetch raw daily metrics (last `windowDays` days) from Metabase.
//   3. Fetch campaign-level settings from Google Ads (budget, tROAS, etc).
//   4. Enrich daily rows with settings via left join on campaign_id.
//   5. Chain models: baseline → anomaly + confidence → elasticity
//      → build latest-day enriched frame → saturation → lever → scores
//      → constraints (guardrails).
//   6. For each actionable campaign, build a Candidate, refine() it via
//      persistDecision() — failures on a single campaign are collected but
//      do NOT abort the whole run (production resilience).
//   7. Close the run with status='success' / 'failed' and counters.
//
// The orchestrator takes `nowIso` so tests can pin the window deterministically.

import type { GodeployDB } from '@/db/bootstrap'
import type { MetabaseClient } from '@/clients/metabase'
import type { GoogleAdsClient } from '@/clients/googleAds'
import { RunsRepo } from '@/db/repos/runs'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import {
  classifyBiddingLearning,
  type BiddingLearningStatus,
} from '@/agent/refiners/biddingLearning'
import {
  RECOMMENDATION_STALE_HOURS,
  REC_REJECTION_COOLDOWN_DAYS,
  REC_VARIATION_RESET_THRESHOLD,
} from '@/core/constants'
import { applyRevenueOverlay, type RevenueOverlayResult } from './revenueOverlay'
import type { Env } from '@/index'
import { uuid } from '@/lib/uuid'
import { leftJoin } from '@/lib/df'
import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { addRobustAnomalyFlags } from '@/models/anomalyDetection'
import { addConfidenceFeatures } from '@/models/confidenceScore'
import { buildCampaignElasticityFeatures } from '@/models/marginalElasticity'
import { addSaturationFeatures } from '@/models/saturation'
import { addLeverDiagnosis } from '@/models/leverDiagnosis'
import { addCampaignScores } from '@/models/campaignScores'
import { applyGuardrails } from '@/models/constraintsOptimizer'
import { persistDecision } from '@/agent/tools/persistDecision'

export const PIPELINE_VERSION = '0.1.0'

export interface RunOptions {
  accountId: string
  /** Google Ads customer id (the customer to query against; MCC header is on the client). */
  loginCustomerId: string
  /** Default 60 days. Controls the daily metrics window. */
  windowDays?: number
  /** Override the company filter on the Metabase pull. Defaults to 'Apice'. */
  company?: string
}

export interface RunResult {
  runId: string
  status: 'success' | 'failed'
  nCampaignsScanned: number
  nRecommendations: number
  /** Campaigns the pipeline would have written a rec for but skipped because
   *  a non-terminal rec for the same campaign already existed. Surfaces the
   *  dedup behaviour so operators can spot stuck queues at a glance. */
  nSkippedDedup: number
  /** Stale recs (pending / sent_to_chat older than RECOMMENDATION_STALE_HOURS)
   *  that this run auto-expired before the dedup gate. A non-zero value here
   *  is normal — it shows that operator engagement decayed and we're cycling
   *  fresh decisions. Persistent high counts hint at a saturated Chat queue. */
  nExpiredStale: number
  /** Campaigns dropped because their current Google Ads status is not
   *  `ENABLED` (paused, removed, or unknown). Primary filter is the GAQL
   *  WHERE clause; this counter catches edge cases where the Metabase
   *  daily window has historical data for a now-paused campaign. */
  nSkippedNotEnabled: number
  /** Candidates skipped because an operator rejected a similar rec for
   *  the same (campaign, action) within the cooldown window AND the new
   *  proposal didn't clear the variation threshold. Defends against the
   *  "rejecting the same suggestion day after day" pattern. */
  nSkippedRejectionCooldown: number
  /** Revenue overlay telemetry. Surfaces how many daily rows had the
   *  Google-Ads `conversion_value` proxy replaced with ground-truth
   *  revenue from the configured e-commerce provider (Yampi today).
   *  Zero values either mean no provider configured or the fetch failed
   *  — both fall back to the proxy. */
  revenueOverlay: RevenueOverlayResult
  errors: string[]
}

/** Run the full model pipeline for one account, persisting recommendations.
 *
 *  `env` is forwarded to the revenue-overlay step so it can resolve the
 *  configured e-commerce provider's credentials. Pass `null` to skip the
 *  overlay (used by tests that don't have an Env binding handy — the
 *  pipeline still runs end-to-end on the proxy). */
export async function runModelsForAccount(
  db: GodeployDB,
  metabase: MetabaseClient,
  googleAds: GoogleAdsClient,
  opts: RunOptions,
  nowIso: string,
  env: Env | null = null,
): Promise<RunResult> {
  const runId = uuid()
  const windowDays = opts.windowDays ?? 60
  const company = opts.company ?? 'Apice'
  const runs = new RunsRepo(db)
  const errors: string[] = []

  const windowEnd = nowIso.slice(0, 10)
  const windowStartMs =
    Date.parse(`${windowEnd}T00:00:00Z`) - windowDays * 24 * 3600 * 1000
  const windowStart = new Date(windowStartMs).toISOString().slice(0, 10)

  await runs.insert({
    run_id: runId,
    account_id: opts.accountId,
    pipeline_version: PIPELINE_VERSION,
    status: 'running',
    n_campaigns_scanned: null,
    n_recommendations: null,
    input_window_start: windowStart,
    input_window_end: windowEnd,
    notes: null,
  })

  try {
    const dailySql = buildDailySql(company, windowStart, windowEnd)
    const dailyRaw = await metabase.querySql<DailyRow>(dailySql)
    const daily = normaliseDailyRows(dailyRaw)

    const settingsRaw = await googleAds.searchStream(
      opts.loginCustomerId,
      buildSettingsGaql(),
    )
    const settings = parseSettings(settingsRaw)

    // Real-revenue overlay: replace conversion_value (Google Ads proxy) with
    // the e-commerce ground truth where we have a (date, campaign_name)
    // match. Failure is non-fatal — we keep the proxy and log the cause.
    // The overlay runs BEFORE the baseline/elasticity models so every
    // downstream calculation sees the corrected figure.
    const revenueOverlay = env
      ? await applyRevenueOverlay(env, opts.accountId, daily, windowStart, windowEnd)
      : { nOrdersFetched: 0, nOrdersFromGoogleAds: 0, nOrdersWithoutCampaign: 0, nRowsOverridden: 0, realRevenueBrlTotal: 0 }

    // Auto-expire unengaged recs older than the stale window BEFORE the
    // dedup gate runs. This is what allows a fresh run to overwrite an
    // ignored rec for the same campaign — the user's design call: "if it
    // wasn't accepted in 12h, just generate again, no problem." See
    // RECOMMENDATION_STALE_HOURS in core/constants.ts for the rationale on
    // which statuses are swept (only pending + sent_to_chat).
    const staleCutoffMs =
      Date.parse(nowIso) - RECOMMENDATION_STALE_HOURS * 3600 * 1000
    const staleCutoffIso = new Date(staleCutoffMs).toISOString()
    const recsRepoForExpire = new RecommendationsRepo(db)
    const nExpiredStale = await recsRepoForExpire.expireStaleByAccount(
      opts.accountId,
      staleCutoffIso,
    )

    if (daily.length === 0) {
      await runs.updateStatus(runId, 'success', 0, 0)
      return {
        runId,
        status: 'success',
        nCampaignsScanned: 0,
        nRecommendations: 0,
        nSkippedDedup: 0,
        nSkippedNotEnabled: 0,
        nSkippedRejectionCooldown: 0,
        nExpiredStale,
        revenueOverlay,
        errors,
      }
    }

    // Enrich daily with campaign-level settings (left join on campaign_id).
    const enrichedDaily = leftJoin(
      daily,
      settings,
      (r) => String(r.campaign_id),
      (s) => String(s.campaign_id),
    )

    // Chained models.
    const baseline = buildBaselineTrendFeatures(
      enrichedDaily as unknown as Record<string, unknown>[],
    )
    // Anomaly + confidence are computed alongside baseline; they aren't used by
    // saturation/lever/scores directly, but running them validates the chain
    // and matches the legacy Python pipeline order.
    addRobustAnomalyFlags(baseline)
    const confidence = addConfidenceFeatures(
      enrichedDaily as unknown as Parameters<typeof addConfidenceFeatures>[0],
    )
    const elasticity = buildCampaignElasticityFeatures(
      enrichedDaily as unknown as Parameters<
        typeof buildCampaignElasticityFeatures
      >[0],
    )

    // Observed 7-day ROAS per campaign, computed from the post-overlay
    // daily series (Yampi revenue where matched, proxy fallback elsewhere).
    // Sum revenue / sum cost over the trailing 7 days from `windowEnd`.
    // Result feeds the chat card so the operator sees "what is the
    // campaign actually delivering" beside the proposed target.
    const observedRoas7dByCampaign = computeObservedRoas7d(daily, windowEnd)

    const latest = buildLatestDayEnriched(baseline, confidence, elasticity, settings)
    const sat = addSaturationFeatures(latest)
    const lev = addLeverDiagnosis(sat)
    const scored = addCampaignScores(lev)
    const constraints = applyGuardrails(scored)

    let nRecs = 0
    let nSkippedDedup = 0
    let nSkippedNotEnabled = 0
    let nSkippedRejectionCooldown = 0
    const nScanned = constraints.length
    // Reuse the same repo instance the expire-sweep created.
    const recsRepo = recsRepoForExpire
    // Cooldown lower bound (UTC). Anything rejected at-or-after this is in
    // the cooldown window; older rejections no longer block.
    const rejectionCooldownAfterIso = new Date(
      Date.parse(nowIso) - REC_REJECTION_COOLDOWN_DAYS * 24 * 3600 * 1000,
    ).toISOString()
    for (const row of constraints) {
      try {
        // Defence-in-depth filter: even with the GAQL WHERE clause, a
        // historical Metabase row for a now-paused campaign could slip
        // through with `campaign_status` either undefined (no settings
        // join match — campaign no longer in Google Ads) or != 'ENABLED'.
        // Either way, drop it before we even try to build a candidate.
        const status = (row as { campaign_status?: unknown }).campaign_status
        if (status !== 'ENABLED') {
          nSkippedNotEnabled++
          continue
        }
        const candidate = buildCandidate(row, opts.accountId, observedRoas7dByCampaign)
        if (candidate === null) continue
        // Dedup gate: one in-flight rec per campaign. If a non-terminal rec
        // already exists (pending/sent_to_chat/approved/executing), the new
        // candidate is dropped — operators never see two conflicting cards
        // for the same campaign, and downstream caps don't get bypassed by
        // double-approving. Terminal states (executed/failed/rejected/
        // expired) free the campaign for a fresh rec.
        const campaignId = (candidate as { campaign_id: string }).campaign_id
        const active = await recsRepo.findActiveByCampaign(
          opts.accountId,
          campaignId,
        )
        if (active !== null) {
          nSkippedDedup++
          console.log(
            JSON.stringify({
              event: 'skipped_dedup_active_exists',
              runId,
              campaignId,
              activeRecommendationId: active.recommendation_id,
              activeStatus: active.status,
            }),
          )
          continue
        }
        // Rejection cooldown + variation gate. If the operator turned down
        // a similar rec for the same (campaign, action) within the
        // cooldown window, only re-pin them when the proposal is
        // meaningfully different in magnitude.
        const c = candidate as {
          recommended_action: string
          change_percent: number | null
        }
        const lastRejected = await recsRepo.findLastRejected(
          opts.accountId,
          campaignId,
          c.recommended_action,
          rejectionCooldownAfterIso,
        )
        if (
          lastRejected !== null &&
          c.change_percent !== null &&
          lastRejected.change_percent !== null
        ) {
          const magnitudeDelta = Math.abs(
            c.change_percent - lastRejected.change_percent,
          )
          if (magnitudeDelta < REC_VARIATION_RESET_THRESHOLD) {
            nSkippedRejectionCooldown++
            console.log(
              JSON.stringify({
                event: 'skipped_rejection_cooldown',
                runId,
                campaignId,
                action: c.recommended_action,
                lastRejectedId: lastRejected.recommendation_id,
                lastRejectedChangePct: lastRejected.change_percent,
                proposedChangePct: c.change_percent,
                magnitudeDelta,
                thresholdRequired: REC_VARIATION_RESET_THRESHOLD,
              }),
            )
            continue
          }
        }
        await persistDecision(db, candidate, {
          runId,
          recommendationId: uuid(),
        })
        nRecs++
      } catch (e) {
        const campaignId = (row as { campaign_id?: unknown }).campaign_id
        errors.push(`campaign=${String(campaignId ?? '?')}: ${(e as Error).message}`)
      }
    }

    await runs.updateStatus(runId, 'success', nScanned, nRecs)
    return {
      runId,
      status: 'success',
      nCampaignsScanned: nScanned,
      nRecommendations: nRecs,
      nSkippedDedup,
      nSkippedNotEnabled,
      nSkippedRejectionCooldown,
      nExpiredStale,
      revenueOverlay,
      errors,
    }
  } catch (e) {
    await runs.updateStatus(runId, 'failed', 0, 0)
    return {
      runId,
      status: 'failed',
      nCampaignsScanned: 0,
      nRecommendations: 0,
      nSkippedDedup: 0,
      nSkippedNotEnabled: 0,
      nSkippedRejectionCooldown: 0,
      nExpiredStale: 0,
      revenueOverlay: {
        nOrdersFetched: 0,
        nOrdersFromGoogleAds: 0,
        nOrdersWithoutCampaign: 0,
        nRowsOverridden: 0,
        realRevenueBrlTotal: 0,
      },
      errors: [(e as Error).message ?? String(e)],
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface DailyRow {
  date: string
  company: string
  campaign_id: string
  campaign_name: string
  campaign_type: string
  cost: number | null
  conversion_value: number | null
  impressions: number | null
  clicks: number | null
  conversions: number | null
  impression_share?: number | null
  lost_is_budget?: number | null
  lost_is_rank?: number | null
  [k: string]: unknown
}

interface SettingsRow {
  campaign_id: string
  campaign_name: string
  budget_brl: number | null
  target_roas: number | null
  target_cpa_brl: number | null
  bidding_strategy_type: string | null
  campaign_status: string | null
  budget_resource_name: string | null
  /** Smart Bidding state classified from `bidding_strategy_system_status`.
   *  See `agent/refiners/biddingLearning.ts` for the value semantics. */
  bidding_learning_status: BiddingLearningStatus
}

/** Build the Metabase SQL for the daily-grain pull.
 *  Canonical query mirroring legacy/python/queries/01_campaign_daily_metrics.sql.
 *  Aggregates raw.gogroup_google_ads (ad-grain) to campaign-grain via GROUP BY,
 *  then LEFT JOINs raw.gogroup_google_ads_campaigns for auction signals. */
export function buildDailySql(company: string, start: string, end: string): string {
  const safeCompany = company.replace(/'/g, "''")
  return `
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
      WHERE company = '${safeCompany}' AND date BETWEEN '${start}' AND '${end}'
      GROUP BY date, company, campaign_id
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
      WHERE company = '${safeCompany}' AND date BETWEEN '${start}' AND '${end}'
    )
    SELECT
      ad_daily.date::text AS date,
      ad_daily.company,
      ad_daily.campaign_id::text AS campaign_id,
      COALESCE(campaign_attrs.campaign_name, ad_daily.campaign_name) AS campaign_name,
      COALESCE(campaign_attrs.campaign_type, ad_daily.campaign_type) AS campaign_type,
      ad_daily.cost::float8 AS cost,
      ad_daily.conversion_value::float8 AS conversion_value,
      ad_daily.impressions::int AS impressions,
      ad_daily.clicks::int AS clicks,
      ad_daily.conversions::float8 AS conversions,
      campaign_attrs.impression_share::float8 AS impression_share,
      campaign_attrs.lost_is_budget::float8 AS lost_is_budget,
      campaign_attrs.lost_is_rank::float8 AS lost_is_rank
    FROM ad_daily
    LEFT JOIN campaign_attrs
      ON campaign_attrs.date = ad_daily.date
     AND campaign_attrs.company = ad_daily.company
     AND campaign_attrs.campaign_id = ad_daily.campaign_id
    ORDER BY ad_daily.campaign_id, ad_daily.date
  `
}

function buildSettingsGaql(): string {
  // `bidding_strategy_system_status` is the unified Smart Bidding state field
  // (ENABLED / LEARNING_* / LIMITED_* / MISCONFIGURED_*). Required by the
  // learning-phase guardrail; absent values fall through to `unknown` and the
  // guardrail does not fire. See agent/refiners/biddingLearning.ts.
  // `WHERE campaign.status = ENABLED` filters out PAUSED and REMOVED
  // campaigns at the source — we never want to recommend changes on a
  // campaign that isn't serving. Defence-in-depth: the pipeline also
  // re-checks `campaign_status === 'ENABLED'` before building a candidate
  // (catches cases where the campaign was active in the Metabase window but
  // is paused now).
  return `
    SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
           campaign.bidding_strategy_system_status,
           campaign_budget.resource_name, campaign_budget.amount_micros,
           campaign.maximize_conversion_value.target_roas
    FROM campaign
    WHERE campaign.status = 'ENABLED'
  `
}

/** Coerce numeric Metabase columns to numbers (CSV-style strings → number). */
function normaliseDailyRows(rows: DailyRow[]): DailyRow[] {
  const numericCols: Array<keyof DailyRow> = [
    'cost',
    'conversion_value',
    'impressions',
    'clicks',
    'conversions',
    'impression_share',
    'lost_is_budget',
    'lost_is_rank',
  ]
  return rows.map((r) => {
    const out: DailyRow = { ...r }
    for (const c of numericCols) {
      const v = out[c]
      if (v === null || v === undefined || v === '') {
        out[c] = null as DailyRow[typeof c]
        continue
      }
      if (typeof v === 'number') continue
      const n = Number(v)
      out[c] = (Number.isFinite(n) ? n : null) as DailyRow[typeof c]
    }
    return out
  })
}

function parseSettings(raw: unknown[]): SettingsRow[] {
  return raw.map((r) => {
    const row = r as {
      campaign?: {
        id?: string | number
        name?: string
        status?: string
        biddingStrategyType?: string
        biddingStrategySystemStatus?: string
        maximizeConversionValue?: { targetRoas?: number | null }
      }
      campaignBudget?: {
        amountMicros?: string | number
        resourceName?: string
      }
    }
    const micros = row.campaignBudget?.amountMicros
    const budgetBrl =
      micros === undefined || micros === null
        ? null
        : Number(micros) / 1_000_000
    return {
      campaign_id: String(row.campaign?.id ?? ''),
      campaign_name: String(row.campaign?.name ?? ''),
      budget_brl: budgetBrl !== null && Number.isFinite(budgetBrl) ? budgetBrl : null,
      target_roas: row.campaign?.maximizeConversionValue?.targetRoas ?? null,
      target_cpa_brl: null,
      bidding_strategy_type: row.campaign?.biddingStrategyType ?? null,
      campaign_status: row.campaign?.status ?? null,
      budget_resource_name: row.campaignBudget?.resourceName ?? null,
      bidding_learning_status: classifyBiddingLearning(
        row.campaign?.biddingStrategySystemStatus ?? null,
      ),
    }
  })
}

/** Build the one-row-per-campaign latest-day frame consumed by
 *  saturation / lever / scores / constraints. Merges the latest baseline row
 *  with confidence features, campaign elasticity, and Google Ads settings. */
function buildLatestDayEnriched(
  baseline: Record<string, unknown>[],
  confidence: Record<string, unknown>[],
  elasticity: ReturnType<typeof buildCampaignElasticityFeatures>,
  settings: SettingsRow[],
): Record<string, unknown>[] {
  const latestBaselineByCampaign = new Map<string, Record<string, unknown>>()
  for (const r of baseline) {
    const k = `${String(r['company'] ?? '')}|${String(r['campaign_id'] ?? '')}`
    const prev = latestBaselineByCampaign.get(k)
    const dateA = String(r['date'] ?? '')
    const dateB = prev ? String(prev['date'] ?? '') : ''
    if (!prev || dateA > dateB) latestBaselineByCampaign.set(k, r)
  }

  const confByKey = new Map<string, Record<string, unknown>>()
  for (const r of confidence) {
    const k = `${String(r['company'] ?? '')}|${String(r['campaign_id'] ?? '')}|${String(
      r['date'] ?? '',
    )}`
    confByKey.set(k, r)
  }

  const elasByCampaign = new Map<string, (typeof elasticity)[number]>()
  for (const r of elasticity) {
    elasByCampaign.set(`${r.company}|${r.campaign_id}`, r)
  }

  const settingsByCampaign = new Map(
    settings.map((s) => [String(s.campaign_id), s] as const),
  )

  const out: Record<string, unknown>[] = []
  for (const [k, base] of latestBaselineByCampaign) {
    const date = String(base['date'] ?? '')
    const conf = confByKey.get(`${k}|${date}`) ?? {}
    const elas = elasByCampaign.get(k)
    const cid = String(base['campaign_id'] ?? '')
    const sett = settingsByCampaign.get(cid)

    const baseRoas =
      typeof base['roas'] === 'number' && Number.isFinite(base['roas'] as number)
        ? (base['roas'] as number)
        : null

    const enriched: Record<string, unknown> = {
      ...base,
      ...conf,
      ...(elas ?? {}),
      ...(sett ?? {}),
      current_roas: baseRoas,
      // `proxy_target_roas` falls back to the elasticity-stage campaign avg
      // when the Google Ads settings don't carry an explicit target_roas.
      proxy_target_roas:
        sett?.target_roas ??
        (elas as { current_roas?: number | null } | undefined)?.current_roas ??
        null,
      // Heuristic default; refine() will clamp & guardrail this.
      recommended_change_pct: 0.1,
    }
    out.push(enriched)
  }
  return out
}

/** Build a Skill Candidate from one constraints row. Returns null when the row
 *  is not actionable (no recommendation, monitor, or pause). */
function buildCandidate(
  row: Record<string, unknown>,
  accountId: string,
  observedRoas7dByCampaign: Map<string, number | null>,
): unknown | null {
  const action = row['recommended_action']
  if (typeof action !== 'string') return null
  if (action === 'monitor' || action === 'pause' || action === '') return null

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  const campaignId = String(row['campaign_id'] ?? '')
  return {
    account_id: accountId,
    campaign_id: campaignId,
    campaign_name: String(row['campaign_name'] ?? ''),
    skill_type: 'budget_reallocation',
    recommended_action: action,
    change_percent: num(row['recommended_change_pct']) ?? 0.1,
    current_budget_brl: num(row['budget_brl']),
    current_target_roas: num(row['target_roas']),
    expected_marginal_roas: num(row['marginal_roas']),
    confidence_score:
      typeof row['confidence_score'] === 'number'
        ? Math.round(row['confidence_score'] as number)
        : null,
    risk_level:
      row['risk_level'] === 'low' ||
      row['risk_level'] === 'medium' ||
      row['risk_level'] === 'high'
        ? row['risk_level']
        : null,
    reason:
      (typeof row['guardrail_reason'] === 'string'
        ? row['guardrail_reason']
        : null) ??
      (typeof row['primary_constraint'] === 'string'
        ? (row['primary_constraint'] as string)
        : null),
    budget_resource_name:
      typeof row['budget_resource_name'] === 'string'
        ? row['budget_resource_name']
        : null,
    bidding_learning_status: pickLearningStatus(row['bidding_learning_status']),
    observed_roas_7d: observedRoas7dByCampaign.get(campaignId) ?? null,
  }
}

/**
 * Aggregate sum(conversion_value) / sum(cost) over the last 7 days per
 * campaign. Uses the daily series AFTER the Yampi overlay was applied, so
 * the ROAS reflects the ground-truth revenue (or proxy fallback) and
 * matches what the operator would see in their ground-truth dashboard.
 *
 * Returns Map<campaign_id, ratio | null>. Null when there's no cost in
 * the window (campaign just launched, paused, or has no data) — we don't
 * surface "Infinity" or "0" ROAS, those are nonsense.
 */
export function computeObservedRoas7d(
  daily: DailyRow[],
  windowEndYmd: string,
): Map<string, number | null> {
  // 7-day window ending on windowEndYmd (inclusive).
  const endMs = Date.parse(`${windowEndYmd}T00:00:00Z`)
  const startMs = endMs - 6 * 24 * 3600 * 1000 // 7 days inclusive
  const startYmd = new Date(startMs).toISOString().slice(0, 10)

  const sums = new Map<string, { cost: number; revenue: number }>()
  for (const row of daily) {
    if (row.date < startYmd || row.date > windowEndYmd) continue
    const id = String(row.campaign_id ?? '')
    if (!id) continue
    const cost = typeof row.cost === 'number' && Number.isFinite(row.cost) ? row.cost : 0
    const rev =
      typeof row.conversion_value === 'number' && Number.isFinite(row.conversion_value)
        ? row.conversion_value
        : 0
    const cur = sums.get(id) ?? { cost: 0, revenue: 0 }
    cur.cost += cost
    cur.revenue += rev
    sums.set(id, cur)
  }

  const out = new Map<string, number | null>()
  for (const [id, { cost, revenue }] of sums) {
    if (cost === 0) {
      out.set(id, null)
    } else {
      out.set(id, Math.round((revenue / cost) * 100) / 100)
    }
  }
  return out
}

/** Narrow an unknown into a `BiddingLearningStatus`, defaulting to `unknown`
 *  for any value we don't recognise. Kept out of the candidate builder
 *  literal so the inline shape stays readable. */
function pickLearningStatus(v: unknown): BiddingLearningStatus {
  if (v === 'stable' || v === 'learning' || v === 'limited' || v === 'unknown') {
    return v
  }
  return 'unknown'
}
