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
  errors: string[]
}

/** Run the full model pipeline for one account, persisting recommendations. */
export async function runModelsForAccount(
  db: GodeployDB,
  metabase: MetabaseClient,
  googleAds: GoogleAdsClient,
  opts: RunOptions,
  nowIso: string,
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

    if (daily.length === 0) {
      await runs.updateStatus(runId, 'success', 0, 0)
      return {
        runId,
        status: 'success',
        nCampaignsScanned: 0,
        nRecommendations: 0,
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

    const latest = buildLatestDayEnriched(baseline, confidence, elasticity, settings)
    const sat = addSaturationFeatures(latest)
    const lev = addLeverDiagnosis(sat)
    const scored = addCampaignScores(lev)
    const constraints = applyGuardrails(scored)

    let nRecs = 0
    const nScanned = constraints.length
    for (const row of constraints) {
      try {
        const candidate = buildCandidate(row, opts.accountId)
        if (candidate === null) continue
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
      errors,
    }
  } catch (e) {
    await runs.updateStatus(runId, 'failed', 0, 0)
    return {
      runId,
      status: 'failed',
      nCampaignsScanned: 0,
      nRecommendations: 0,
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
  return `
    SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
           campaign_budget.resource_name, campaign_budget.amount_micros,
           campaign.maximize_conversion_value.target_roas
    FROM campaign
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
): unknown | null {
  const action = row['recommended_action']
  if (typeof action !== 'string') return null
  if (action === 'monitor' || action === 'pause' || action === '') return null

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

  return {
    account_id: accountId,
    campaign_id: String(row['campaign_id'] ?? ''),
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
  }
}
