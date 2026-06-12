// src/pipeline/revenueOverlay.ts
//
// Replaces the Google-Ads `conversion_value` proxy with ground-truth revenue
// from the configured e-commerce provider (Yampi today). Two responsibilities:
//
//   1. Fetch + aggregate paid orders into a (date, campaign_name) → revenue
//      map. Pure transformation once we have the orders in hand.
//   2. Overlay that map onto the daily Metabase rows in-place — match on
//      (date, campaign_name); rows without a match keep the proxy as fallback.
//
// Failure mode is deliberate: if the Yampi fetch throws (auth, rate limit,
// network, bad creds) the overlay returns null + logs a structured warning,
// and the pipeline keeps running on the proxy. Better to under-attribute one
// day than to drop the whole run.

import { YampiClient } from '@/clients/yampi'
import { getRevenueSource } from '@/config/revenueSources'
import type { Env } from '@/index'

export interface RevenueOverlayResult {
  /** Total orders fetched from the provider (post status_alias=paid filter). */
  nOrdersFetched: number
  /** Orders whose utm_source was the relevant ad platform (google for now). */
  nOrdersFromGoogleAds: number
  /** Orders dropped because they lacked utm_campaign (organic / direct tags). */
  nOrdersWithoutCampaign: number
  /** Daily rows whose conversion_value was overwritten with the real figure. */
  nRowsOverridden: number
  /** Sum of value_total across the overlay map, in BRL. Useful sanity check. */
  realRevenueBrlTotal: number
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
  nOrdersFetched: 0,
  nOrdersFromGoogleAds: 0,
  nOrdersWithoutCampaign: 0,
  nRowsOverridden: 0,
  realRevenueBrlTotal: 0,
}

/**
 * Apply the real-revenue overlay to `daily` in-place. Returns telemetry, or
 * a zeroed result (same shape) when the account has no revenue source
 * configured / Yampi fetch failed. Never throws — the pipeline must keep
 * going on a fallback path.
 *
 * Constructed YampiClient is injectable via the optional `clientFactory`
 * so tests can mock without touching env.
 */
export async function applyRevenueOverlay(
  env: Env,
  accountId: string,
  daily: OverlayableRow[],
  fromDate: string,
  toDate: string,
  clientFactory: (
    alias: string,
    userToken: string,
    userSecretKey: string,
  ) => YampiClient = (alias, userToken, userSecretKey) =>
    new YampiClient({ alias, userToken, userSecretKey }),
): Promise<RevenueOverlayResult> {
  const cfg = getRevenueSource(accountId)
  if (cfg === null) return SKIPPED

  // Resolve env-var-name → value. Either credential missing → graceful skip
  // with a structured log so operators see the misconfiguration in metrics.
  const userToken = env[cfg.credentials.userTokenEnv] as string | undefined
  const userSecretKey = env[cfg.credentials.userSecretKeyEnv] as string | undefined
  if (!userToken || !userSecretKey) {
    console.log(
      JSON.stringify({
        event: 'revenue_overlay_skipped_no_creds',
        accountId,
        provider: cfg.provider,
        userTokenSet: Boolean(userToken),
        userSecretKeySet: Boolean(userSecretKey),
      }),
    )
    return SKIPPED
  }

  let orders
  try {
    const client = clientFactory(cfg.alias, userToken, userSecretKey)
    orders = await client.fetchPaidOrders({ fromDate, toDate })
  } catch (e) {
    console.log(
      JSON.stringify({
        event: 'revenue_overlay_fetch_failed',
        accountId,
        provider: cfg.provider,
        error: (e as Error).message,
      }),
    )
    return SKIPPED
  }

  const nOrdersFetched = orders.length
  // Only orders attributable to Google Ads matter for our pipeline — Meta /
  // Insider / email / organic revenue exists but doesn't belong to a Google
  // Ads campaign we'd recommend changes on.
  const googleOrders = orders.filter((o) => o.utm.source === 'google')
  const withCampaign = googleOrders.filter((o) => o.utm.campaign !== null)
  const nOrdersFromGoogleAds = googleOrders.length
  const nOrdersWithoutCampaign = googleOrders.length - withCampaign.length

  // Aggregate (date, utm_campaign) → sum(value_total).
  // utm_campaign is matched against the Google Ads campaign.name (see
  // docs/REVENUE_SOURCES.md — the traffic team convention is
  // utm_campaign == campaign.name, validated against the live API on
  // 2026-06-12 with 100 % exact match).
  const revenueByKey = new Map<string, number>()
  for (const o of withCampaign) {
    const day = o.createdAt?.slice(0, 10)
    if (!day) continue
    const key = `${day}|${o.utm.campaign}`
    revenueByKey.set(key, (revenueByKey.get(key) ?? 0) + o.totalBrl)
  }

  // Overlay onto daily rows.
  let nRowsOverridden = 0
  let realRevenueBrlTotal = 0
  for (const row of daily) {
    const key = `${row.date}|${row.campaign_name}`
    const real = revenueByKey.get(key)
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
      nOrdersFetched,
      nOrdersFromGoogleAds,
      nOrdersWithoutCampaign,
      nRowsOverridden,
      realRevenueBrlTotal,
    }),
  )

  return {
    nOrdersFetched,
    nOrdersFromGoogleAds,
    nOrdersWithoutCampaign,
    nRowsOverridden,
    realRevenueBrlTotal,
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
