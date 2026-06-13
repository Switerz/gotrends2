// src/pipeline/revenueSync.ts
//
// Sync orchestration for the `campaign_revenue_daily` cache. Fetches paid
// orders from the configured e-commerce provider in small windows, aggregates
// by (campaign_name, date), and upserts into the local table.
//
// Decoupled from the pipeline: cron `/cron/sync-revenue` (daily) and admin
// `/api/admin/trigger/backfill-revenue` invoke this. The pipeline itself
// only reads the local table — never the provider.
//
// Two operating modes (same helper, different windows):
//   - Incremental: re-sync the last few days every night to catch
//     late-arriving orders + extend forward by one day.
//   - Backfill: walk N days backward in chunks for the initial seed.
//
// Robustness: 429 rate-limit is retried with exponential backoff per chunk.
// A chunk that exhausts retries is skipped (logged) — the cron is idempotent,
// the next nightly run will fill the gap.

import { YampiClient } from '@/clients/yampi'
import { CampaignRevenueRepo } from '@/db/repos/campaignRevenue'
import { getRevenueSource } from '@/config/revenueSources'
import type { Env } from '@/index'
import type { GodeployDB } from '@/db/bootstrap'

/** Days per Yampi fetch window. Smaller than the client's chunking
 *  default because we want each chunk to fit comfortably under the 10k
 *  ceiling AND give 429 retries plenty of headroom. */
const SYNC_CHUNK_DAYS = 1

/** Max retry attempts per chunk on 429 (Too Many Attempts). */
const MAX_RETRIES = 3

/** Initial backoff between retries; doubles each attempt. */
const RETRY_BACKOFF_MS = 1500

export interface RevenueSyncResult {
  accountId: string
  provider: string | null
  windowsScanned: number
  rowsUpserted: number
  ordersAggregated: number
  errors: Array<{ fromDate: string; toDate: string; error: string }>
}

const SKIPPED_NO_CONFIG = (accountId: string): RevenueSyncResult => ({
  accountId,
  provider: null,
  windowsScanned: 0,
  rowsUpserted: 0,
  ordersAggregated: 0,
  errors: [],
})

/**
 * Sync `[fromDate, toDate]` inclusive into `campaign_revenue_daily` for one
 * account. Never throws — chunk failures collect into `errors`. The cron
 * caller is expected to log + retry next night.
 *
 * The `clientFactory` lets tests inject a fake Yampi client; production
 * callers omit it and the helper instantiates a real YampiClient from env.
 */
export async function syncRevenueRange(
  env: Env,
  db: GodeployDB,
  accountId: string,
  fromDate: string,
  toDate: string,
  clientFactory: (
    alias: string,
    userToken: string,
    userSecretKey: string,
  ) => YampiClient = (alias, userToken, userSecretKey) =>
    new YampiClient({ alias, userToken, userSecretKey }),
): Promise<RevenueSyncResult> {
  const cfg = getRevenueSource(accountId)
  if (cfg === null) return SKIPPED_NO_CONFIG(accountId)

  const userToken = env[cfg.credentials.userTokenEnv] as string | undefined
  const userSecretKey = env[cfg.credentials.userSecretKeyEnv] as string | undefined
  if (!userToken || !userSecretKey) {
    console.log(
      JSON.stringify({
        event: 'revenue_sync_skipped_no_creds',
        accountId,
        provider: cfg.provider,
      }),
    )
    return SKIPPED_NO_CONFIG(accountId)
  }

  const client = clientFactory(cfg.alias, userToken, userSecretKey)
  const repo = new CampaignRevenueRepo(db)
  const chunks = chunkDateRange(fromDate, toDate, SYNC_CHUNK_DAYS)

  const errors: RevenueSyncResult['errors'] = []
  let rowsUpserted = 0
  let ordersAggregated = 0
  // If we get N consecutive 429s after all retries, the provider has
  // locked us out at the session/quota level — burning wall-clock on more
  // retries won't help. Bail with partial progress.
  let consecutive429Failures = 0
  const MAX_CONSECUTIVE_429 = 3

  for (const chunk of chunks) {
    if (consecutive429Failures >= MAX_CONSECUTIVE_429) {
      console.log(
        JSON.stringify({
          event: 'revenue_sync_aborted_persistent_429',
          accountId,
          chunksScanned: chunks.indexOf(chunk),
          chunksRemaining: chunks.length - chunks.indexOf(chunk),
          rowsUpserted,
          note: 'Provider rate limit; resume on the next nightly sync',
        }),
      )
      break
    }
    let attempt = 0
    let succeeded = false
    while (attempt <= MAX_RETRIES && !succeeded) {
      try {
        const orders = await client.fetchPaidOrders({
          fromDate: chunk.fromDate,
          toDate: chunk.toDate,
        })
        // Group: (utm_campaign, date) → { revenue, count }. Only
        // utm_source=google qualifies — Meta / Insider / etc. live in
        // their own platforms.
        const buckets = new Map<string, { revenue: number; count: number }>()
        for (const o of orders) {
          if (o.utm.source !== 'google') continue
          if (!o.utm.campaign) continue
          const day = o.createdAt?.slice(0, 10)
          if (!day) continue
          const key = `${o.utm.campaign}|${day}`
          const cur = buckets.get(key) ?? { revenue: 0, count: 0 }
          cur.revenue += o.totalBrl
          cur.count += 1
          buckets.set(key, cur)
          ordersAggregated++
        }
        for (const [key, { revenue, count }] of buckets) {
          const idx = key.lastIndexOf('|')
          const campaign_name = key.slice(0, idx)
          const date = key.slice(idx + 1)
          await repo.upsert({
            account_id: accountId,
            campaign_name,
            date,
            provider: cfg.provider,
            revenue_brl: Math.round(revenue * 100) / 100,
            n_orders: count,
          })
          rowsUpserted++
        }
        succeeded = true
        consecutive429Failures = 0 // any success resets the streak
      } catch (e) {
        const msg = (e as Error).message
        if (/429|Too Many Attempts/i.test(msg) && attempt < MAX_RETRIES) {
          const delay = RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.log(
            JSON.stringify({
              event: 'revenue_sync_429_retry',
              accountId,
              fromDate: chunk.fromDate,
              toDate: chunk.toDate,
              attempt: attempt + 1,
              backoffMs: delay,
            }),
          )
          await sleep(delay)
          attempt++
        } else {
          errors.push({
            fromDate: chunk.fromDate,
            toDate: chunk.toDate,
            error: msg,
          })
          if (/429|Too Many Attempts/i.test(msg)) {
            consecutive429Failures++
          }
          break
        }
      }
    }
  }

  const result: RevenueSyncResult = {
    accountId,
    provider: cfg.provider,
    windowsScanned: chunks.length,
    rowsUpserted,
    ordersAggregated,
    errors,
  }
  console.log(JSON.stringify({ event: 'revenue_sync_done', ...result }))
  return result
}

/**
 * Incremental nightly sync helper. Re-syncs the last few days even when the
 * table already has them (catches late-arriving orders) and extends forward
 * to yesterday.
 *
 * Lookback of 3 days = "today" (partial) + 2 prior days. Cheap, safe.
 */
export async function syncRevenueIncremental(
  env: Env,
  db: GodeployDB,
  accountId: string,
  nowIso: string,
): Promise<RevenueSyncResult> {
  const repo = new CampaignRevenueRepo(db)
  const latest = await repo.latestDateForAccount(accountId)
  const today = nowIso.slice(0, 10)
  const lookbackDate = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10)
  // Start = max(latest - 2 days, lookbackDate) — but simpler and equivalent:
  // always re-sync the last 3 days. If `latest` is older (gap), fall back to
  // that to fill the hole.
  const start = latest && latest < lookbackDate ? latest : lookbackDate
  return syncRevenueRange(env, db, accountId, start, today)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function chunkDateRange(
  fromDate: string,
  toDate: string,
  chunkDays: number,
): Array<{ fromDate: string; toDate: string }> {
  const fromMs = Date.parse(`${fromDate}T00:00:00Z`)
  const toMs = Date.parse(`${toDate}T00:00:00Z`)
  const dayMs = 24 * 3600 * 1000
  const out: Array<{ fromDate: string; toDate: string }> = []
  for (let cursor = fromMs; cursor <= toMs; cursor += chunkDays * dayMs) {
    const endMs = Math.min(cursor + (chunkDays - 1) * dayMs, toMs)
    out.push({
      fromDate: new Date(cursor).toISOString().slice(0, 10),
      toDate: new Date(endMs).toISOString().slice(0, 10),
    })
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
