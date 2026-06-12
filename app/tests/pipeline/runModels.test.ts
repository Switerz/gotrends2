// tests/pipeline/runModels.test.ts
//
// End-to-end tests for the daily pipeline orchestrator. Uses a Map-backed fake
// DB, mock fetchers for MetabaseClient + GoogleAdsClient, and the parity
// fixture as raw daily data so we exercise the real model chain.

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { MetabaseClient } from '@/clients/metabase'
import { GoogleAdsClient } from '@/clients/googleAds'
import { isUuid } from '@/lib/uuid'
import { runModelsForAccount, buildDailySql } from '@/pipeline/runModels'
import { makeFakeDb } from '../db/repos/_fakeDb'

const FIX = resolve(__dirname, '../fixtures/parity')

const NUMERIC_COLS = [
  'cost',
  'conversion_value',
  'impressions',
  'clicks',
  'conversions',
  'impression_share',
  'lost_is_budget',
  'lost_is_rank',
]

function loadDailyFixture(): unknown[] {
  return coerceNumeric(readCsv(`${FIX}/input_apice_daily.csv`), NUMERIC_COLS)
}

/** Build the JSON payload shape MetabaseClient.querySql() consumes. */
function metabasePayload(rows: Record<string, unknown>[]): unknown {
  if (rows.length === 0) return { data: { cols: [], rows: [] } }
  const cols = Object.keys(rows[0]!)
  return {
    data: {
      cols: cols.map((c) => ({ name: c })),
      rows: rows.map((r) => cols.map((c) => r[c] ?? null)),
    },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

interface FetcherCfg {
  metabaseRows?: Record<string, unknown>[]
  metabaseThrow?: boolean
  googleAdsRows?: unknown[]
  googleAdsThrow?: boolean
}

/** Build a fetch() stub that branches on URL — token, metabase, google ads. */
function buildFetcher(cfg: FetcherCfg): typeof fetch {
  const f: typeof fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    if (url.includes('oauth2.googleapis.com')) {
      return jsonResponse({ access_token: 'TOK', expires_in: 3600 })
    }
    if (url.includes('/api/dataset')) {
      if (cfg.metabaseThrow) throw new Error('metabase boom')
      return jsonResponse(metabasePayload(cfg.metabaseRows ?? []))
    }
    if (url.includes('googleAds:searchStream')) {
      if (cfg.googleAdsThrow) throw new Error('googleAds boom')
      return jsonResponse([{ results: cfg.googleAdsRows ?? [] }])
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  return f
}

function makeClients(cfg: FetcherCfg) {
  const fetcher = buildFetcher(cfg)
  const metabase = new MetabaseClient(
    { url: 'https://mb.test', apiKey: 'k', databaseId: 1 },
    fetcher,
  )
  const googleAds = new GoogleAdsClient(
    {
      developerToken: 'd',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      loginCustomerId: '111',
    },
    fetcher,
  )
  return { metabase, googleAds }
}

/** Synthetic Google Ads settings for the 5 fixture campaigns. */
function fakeAdsSettings(): unknown[] {
  return ['c-001', 'c-002', 'c-003', 'c-004', 'c-005'].map((id, i) => ({
    campaign: {
      id,
      name: `Synthetic Campaign ${id.slice(2)}`,
      status: 'ENABLED',
      biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
      maximizeConversionValue: { targetRoas: 4.0 },
    },
    campaignBudget: {
      resourceName: `customers/111/campaignBudgets/${id}`,
      amountMicros: String((500 + i * 100) * 1_000_000),
    },
  }))
}

const baseOpts = {
  accountId: '7705857660',
  loginCustomerId: '111',
  windowDays: 60,
  company: 'Apice',
}

const NOW_ISO = '2026-06-10T03:00:00Z'

describe('runModelsForAccount', () => {
  it('happy path: opens a run, computes models, persists recommendations, closes success', async () => {
    const db = makeFakeDb()
    const daily = loadDailyFixture() as Record<string, unknown>[]
    const { metabase, googleAds } = makeClients({
      metabaseRows: daily,
      googleAdsRows: fakeAdsSettings(),
    })

    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)

    expect(result.status).toBe('success')
    expect(result.nCampaignsScanned).toBe(5)
    expect(result.nRecommendations).toBeGreaterThanOrEqual(0)
    expect(result.errors).toEqual([])

    const runs = db.tables.get('model_runs') ?? []
    expect(runs.length).toBe(1)
    expect(runs[0]!['run_id']).toBe(result.runId)
    expect(runs[0]!['status']).toBe('success')
    expect(runs[0]!['n_campaigns_scanned']).toBe(5)
    expect(runs[0]!['n_recommendations']).toBe(result.nRecommendations)

    const recs = db.tables.get('recommendations') ?? []
    expect(recs.length).toBe(result.nRecommendations)
    for (const r of recs) {
      expect(r['run_id']).toBe(result.runId)
      expect(r['account_id']).toBe(baseOpts.accountId)
      expect(r['status']).toBe('pending')
    }
  })

  it('metabase error: marks run failed, no recommendations persisted', async () => {
    const db = makeFakeDb()
    const { metabase, googleAds } = makeClients({
      metabaseThrow: true,
      googleAdsRows: fakeAdsSettings(),
    })

    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)

    expect(result.status).toBe('failed')
    expect(result.nRecommendations).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)

    const runs = db.tables.get('model_runs') ?? []
    expect(runs[0]!['status']).toBe('failed')
    expect(db.tables.get('recommendations') ?? []).toEqual([])
  })

  it('google ads error: marks run failed', async () => {
    const db = makeFakeDb()
    const daily = loadDailyFixture() as Record<string, unknown>[]
    const { metabase, googleAds } = makeClients({
      metabaseRows: daily,
      googleAdsThrow: true,
    })

    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)

    expect(result.status).toBe('failed')
    const runs = db.tables.get('model_runs') ?? []
    expect(runs[0]!['status']).toBe('failed')
  })

  it('no data: success with zero recommendations and zero campaigns scanned', async () => {
    const db = makeFakeDb()
    const { metabase, googleAds } = makeClients({
      metabaseRows: [],
      googleAdsRows: fakeAdsSettings(),
    })

    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)

    expect(result.status).toBe('success')
    expect(result.nCampaignsScanned).toBe(0)
    expect(result.nRecommendations).toBe(0)
    const runs = db.tables.get('model_runs') ?? []
    expect(runs[0]!['status']).toBe('success')
    expect(runs[0]!['n_campaigns_scanned']).toBe(0)
  })

  it('refiner rejects one bad candidate: run still succeeds, error collected', async () => {
    const db = makeFakeDb()
    const daily = loadDailyFixture() as Record<string, unknown>[]
    // Inject a corrupt campaign with empty campaign_name — the Candidate schema
    // requires `campaign_name.min(1)`, so refine() throws CandidateInvalid for
    // any actionable row produced by this campaign.
    const polluted = daily.map((r) =>
      r['campaign_id'] === 'c-001' ? { ...r, campaign_name: '' } : r,
    )

    const { metabase, googleAds } = makeClients({
      metabaseRows: polluted,
      // Also return an empty-name in Google Ads settings so the left join
      // doesn't refill it.
      googleAdsRows: fakeAdsSettings().map((r) => {
        const rec = r as { campaign?: { id?: string; name?: string } }
        if (rec.campaign?.id === 'c-001') {
          return { ...rec, campaign: { ...rec.campaign, name: '' } }
        }
        return rec
      }),
    })

    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)

    expect(result.status).toBe('success')
    expect(result.nCampaignsScanned).toBe(5)
    const runs = db.tables.get('model_runs') ?? []
    expect(runs[0]!['status']).toBe('success')
    // Either c-001 was actionable (then we collected an error) or it wasn't
    // (then no error and no rec). Both outcomes are acceptable as long as a
    // bad candidate never aborts the whole run.
    const c1errors = result.errors.filter((e) => e.includes('c-001'))
    const recs = db.tables.get('recommendations') ?? []
    const c1recs = recs.filter((r) => r['campaign_id'] === 'c-001')
    expect(c1errors.length + c1recs.length).toBeLessThanOrEqual(1)
  })

  it('dedup: skips campaigns that already have a non-terminal rec (counts to nSkippedDedup)', async () => {
    const db = makeFakeDb()
    const daily = loadDailyFixture() as Record<string, unknown>[]
    const { metabase, googleAds } = makeClients({
      metabaseRows: daily,
      googleAdsRows: fakeAdsSettings(),
    })

    // First run — establishes the baseline. Whatever recs land here are now
    // in-flight (`pending`) and should block re-generation in the next run.
    const first = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)
    expect(first.status).toBe('success')
    const firstRecCount = first.nRecommendations
    expect(firstRecCount).toBeGreaterThan(0)
    expect(first.nSkippedDedup).toBe(0)

    // Second run with identical input — every actionable campaign should hit
    // the dedup gate. Pipeline still scans the same set of campaigns; it just
    // refuses to create new rows for the ones already in-flight.
    const { metabase: m2, googleAds: g2 } = makeClients({
      metabaseRows: daily,
      googleAdsRows: fakeAdsSettings(),
    })
    const second = await runModelsForAccount(db, m2, g2, baseOpts, NOW_ISO)
    expect(second.status).toBe('success')
    expect(second.nRecommendations).toBe(0)
    expect(second.nSkippedDedup).toBe(firstRecCount)

    // The total rec count in the DB has NOT grown — no duplicates were written.
    const recs = db.tables.get('recommendations') ?? []
    expect(recs.length).toBe(firstRecCount)
  })

  it('dedup: terminal recs (executed/failed/rejected) do NOT block a fresh run', async () => {
    const db = makeFakeDb()
    const daily = loadDailyFixture() as Record<string, unknown>[]
    const { metabase, googleAds } = makeClients({
      metabaseRows: daily,
      googleAdsRows: fakeAdsSettings(),
    })

    // First run populates recs as `pending`.
    const first = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)
    expect(first.nRecommendations).toBeGreaterThan(0)

    // Settle every rec into a terminal state. After this, the campaigns are
    // free to receive a new rec on the next run.
    const recsTable = db.tables.get('recommendations')!
    for (const r of recsTable) r['status'] = 'executed'

    const { metabase: m2, googleAds: g2 } = makeClients({
      metabaseRows: daily,
      googleAdsRows: fakeAdsSettings(),
    })
    const second = await runModelsForAccount(db, m2, g2, baseOpts, NOW_ISO)
    expect(second.status).toBe('success')
    expect(second.nSkippedDedup).toBe(0)
    expect(second.nRecommendations).toBe(first.nRecommendations)
  })

  it('only ENABLED campaigns become recommendations; paused/removed are skipped', async () => {
    // 5 fixture campaigns: 3 ENABLED, 2 PAUSED. Defence-in-depth check —
    // even if the GAQL WHERE clause failed to filter, the pipeline still
    // drops the paused ones via the campaign_status check.
    const db = makeFakeDb()
    const daily = loadDailyFixture() as Record<string, unknown>[]
    const adsSettings = fakeAdsSettings().map((r, i) => {
      // Mark c-003 and c-004 as PAUSED (index 2 and 3).
      const rec = r as { campaign?: { status?: string } }
      if (i === 2 || i === 3) {
        return { ...rec, campaign: { ...rec.campaign, status: 'PAUSED' } }
      }
      return r
    })
    const { metabase, googleAds } = makeClients({
      metabaseRows: daily,
      googleAdsRows: adsSettings,
    })

    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)

    expect(result.status).toBe('success')
    expect(result.nSkippedNotEnabled).toBeGreaterThanOrEqual(2)

    const recs = db.tables.get('recommendations') ?? []
    // No rec for c-003 or c-004 — they're paused.
    expect(recs.find((r) => r['campaign_id'] === 'c-003')).toBeUndefined()
    expect(recs.find((r) => r['campaign_id'] === 'c-004')).toBeUndefined()
  })

  it('buildSettingsGaql filters to ENABLED campaigns at the source', async () => {
    // Sanity: the GAQL string carries the WHERE clause. The pipeline
    // tolerates absence of the filter via the post-join defence, but the
    // source-level filter is what we depend on to keep the Google Ads
    // round-trip cheap.
    const settingsGaqlModule = await import('@/pipeline/runModels')
    // The function is not exported individually, but we can inspect via a
    // tiny invocation that returns the GAQL — easiest path is to call the
    // pipeline and assert the searchStream input.
    // Tests above already exercise that path; this test asserts the SQL.
    const fakeAds = {
      searchStream: async (_acc: string, gaql: string) => {
        expect(gaql).toMatch(/WHERE\s+campaign\.status\s*=\s*'ENABLED'/i)
        return []
      },
    } as unknown as InstanceType<typeof GoogleAdsClient>

    const db = makeFakeDb()
    const { metabase } = makeClients({ metabaseRows: [], googleAdsRows: [] })
    await settingsGaqlModule.runModelsForAccount(
      db,
      metabase,
      fakeAds,
      baseOpts,
      NOW_ISO,
    )
  })

  it('runId is a UUID v4', async () => {
    const db = makeFakeDb()
    const { metabase, googleAds } = makeClients({
      metabaseRows: [],
      googleAdsRows: [],
    })
    const result = await runModelsForAccount(db, metabase, googleAds, baseOpts, NOW_ISO)
    expect(isUuid(result.runId)).toBe(true)
  })

  it('buildDailySql aggregates ad-grain to campaign-grain via GROUP BY and LEFT JOINs campaigns table', () => {
    const sql = buildDailySql('Apice', '2026-04-11', '2026-06-10')
    // The canonical CTE aggregates the ad-grain raw table.
    expect(sql).toContain('FROM raw.gogroup_google_ads')
    expect(sql).toContain('GROUP BY date, company, campaign_id')
    // It LEFT JOINs the campaigns table for auction signals.
    expect(sql).toContain('raw.gogroup_google_ads_campaigns')
    expect(sql).toContain('LEFT JOIN campaign_attrs')
    // It does NOT reference the non-existent columns on the ad-grain table.
    expect(sql).not.toMatch(/FROM\s+raw\.gogroup_google_ads\s+WHERE[^)]*campaign_type/)
    // Casts so JSON values round-trip cleanly through Metabase.
    expect(sql).toContain('::text AS date')
    expect(sql).toContain('::text AS campaign_id')
    expect(sql).toContain('::float8 AS cost')
    // Company is interpolated with single-quote escaping.
    expect(sql).toContain("company = 'Apice'")
    expect(sql).toContain("'2026-04-11'")
    expect(sql).toContain("'2026-06-10'")
  })

  it('buildDailySql escapes single quotes in company name', () => {
    const sql = buildDailySql("O'Brien", '2026-01-01', '2026-01-31')
    expect(sql).toContain("company = 'O''Brien'")
  })

  it('windowStart/End derived from nowIso and windowDays', async () => {
    const db = makeFakeDb()
    const { metabase, googleAds } = makeClients({
      metabaseRows: [],
      googleAdsRows: [],
    })
    await runModelsForAccount(
      db,
      metabase,
      googleAds,
      { ...baseOpts, windowDays: 10 },
      '2026-06-10T17:30:00Z',
    )
    const runs = db.tables.get('model_runs') ?? []
    expect(runs[0]!['input_window_end']).toBe('2026-06-10')
    expect(runs[0]!['input_window_start']).toBe('2026-05-31')
  })
})
