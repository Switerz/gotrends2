// src/pipeline/revenueOverlay.ts
//
// Replaces the Google-Ads `conversion_value` proxy with ground-truth revenue
// from the LOCAL `campaign_revenue_daily` cache. The sync cron (see
// `pipeline/revenueSync.ts`) is the only writer of that table — pipeline
// just reads. This separation decouples pipeline latency / availability from
// the provider's rate limits and 10k-record ceilings.
//
// Two responsibilities:
//   1. Pull rows for the run's window from the local cache.
//   2. Overlay onto the daily Metabase rows in-place — match on
//      (date, campaign_name); rows without a match keep the proxy as fallback.
//
// Failure mode: cache miss / empty / DB error → return zeroed result + log.
// Pipeline keeps running on the proxy. Under-attribution for one window
// beats dropping the run.

import { CampaignRevenueRepo } from '@/db/repos/campaignRevenue'
import { getRevenueSource } from '@/config/revenueSources'
import type { GodeployDB } from '@/db/bootstrap'

export interface RevenueOverlayResult {
  /** Cached (campaign, date) tuples returned from the local revenue table. */
  nCacheRows: number
  /** Daily rows whose conversion_value was overwritten with the real figure. */
  nRowsOverridden: number
  /** Sum of revenue applied to the daily series, in BRL. Sanity check. */
  realRevenueBrlTotal: number
  /** Earliest cached date returned. Null when the cache had nothing. */
  cacheFromDate: string | null
  /** Latest cached date returned. Null when the cache had nothing. */
  cacheToDate: string | null
}

/** Daily row shape we mutate. The pipeline's `DailyRow` is a superset; we
 *  only need `date`, `campaign_name`, and `conversion_value` here so the
 *  module stays decoupled from upstream type churn. */
export interface OverlayableRow {
  date: string
  campaign_name: string
  conversion_value: number | null
  [k: string]: unknown
}

const SKIPPED: RevenueOverlayResult = {
  nCacheRows: 0,
  nRowsOverridden: 0,
  realRevenueBrlTotal: 0,
  cacheFromDate: null,
  cacheToDate: null,
}

/**
 * Apply the real-revenue overlay to `daily` in-place. Reads from the local
 * `campaign_revenue_daily` cache — the pipeline never calls the provider.
 * Never throws — DB miss / empty cache fall back to the proxy.
 */
export async function applyRevenueOverlay(
  db: GodeployDB,
  accountId: string,
  daily: OverlayableRow[],
  fromDate: string,
  toDate: string,
): Promise<RevenueOverlayResult> {
  const cfg = getRevenueSource(accountId)
  if (cfg === null) return SKIPPED

  let rows
  try {
    const repo = new CampaignRevenueRepo(db)
    rows = await repo.listByAccountAndDateRange(accountId, fromDate, toDate)
  } catch (e) {
    console.log(
      JSON.stringify({
        event: 'revenue_overlay_cache_read_failed',
        accountId,
        provider: cfg.provider,
        error: (e as Error).message,
      }),
    )
    return SKIPPED
  }

  if (rows.length === 0) {
    console.log(
      JSON.stringify({
        event: 'revenue_overlay_cache_empty',
        accountId,
        provider: cfg.provider,
        fromDate,
        toDate,
      }),
    )
    return SKIPPED
  }

  // Build a (date|campaign_name) → revenue map. Cache rows are already the
  // aggregated truth; no extra summation needed.
  const revenueByKey = new Map<string, number>()
  let cacheFromDate: string | null = null
  let cacheToDate: string | null = null
  for (const r of rows) {
    if (cacheFromDate === null || r.date < cacheFromDate) cacheFromDate = r.date
    if (cacheToDate === null || r.date > cacheToDate) cacheToDate = r.date
    revenueByKey.set(`${r.date}|${r.campaign_name}`, r.revenue_brl)
  }

  let nRowsOverridden = 0
  let realRevenueBrlTotal = 0
  for (const row of daily) {
    const real = revenueByKey.get(`${row.date}|${row.campaign_name}`)
    if (real === undefined) continue
    row.conversion_value = round2(real)
    nRowsOverridden++
    realRevenueBrlTotal += real
  }
  realRevenueBrlTotal = round2(realRevenueBrlTotal)

  console.log(
    JSON.stringify({
      event: 'revenue_overlay_applied',
      accountId,
      provider: cfg.provider,
      fromDate,
      toDate,
      nCacheRows: rows.length,
      nRowsOverridden,
      realRevenueBrlTotal,
    }),
  )

  return {
    nCacheRows: rows.length,
    nRowsOverridden,
    realRevenueBrlTotal,
    cacheFromDate,
    cacheToDate,
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
