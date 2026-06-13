// tests/pipeline/revenueOverlay.test.ts
//
// Revenue overlay: ground-truth e-commerce revenue replaces the Google-Ads
// `conversion_value` proxy in-place on daily rows. The overlay now reads
// from the local `campaign_revenue_daily` cache (populated by the sync cron)
// — the pipeline NEVER calls the provider at runtime.

import { describe, it, expect } from 'vitest'
import { applyRevenueOverlay, type OverlayableRow } from '@/pipeline/revenueOverlay'
import { CampaignRevenueRepo } from '@/db/repos/campaignRevenue'
import { makeFakeDb } from '../db/repos/_fakeDb'

const ACCOUNT = '7705857660'

function row(
  date: string,
  campaign_name: string,
  conversion_value: number,
): OverlayableRow {
  return { date, campaign_name, conversion_value }
}

async function seedCache(
  db: ReturnType<typeof makeFakeDb>,
  rows: Array<{ campaign_name: string; date: string; revenue_brl: number; n_orders?: number }>,
) {
  const repo = new CampaignRevenueRepo(db)
  for (const r of rows) {
    await repo.upsert({
      account_id: ACCOUNT,
      campaign_name: r.campaign_name,
      date: r.date,
      provider: 'yampi',
      revenue_brl: r.revenue_brl,
      n_orders: r.n_orders ?? 1,
    })
  }
}

describe('applyRevenueOverlay (reads from local cache)', () => {
  it('overlays cached revenue onto matching (date, campaign_name) rows', async () => {
    const db = makeFakeDb()
    await seedCache(db, [
      { campaign_name: 'pesquisa-institucional', date: '2026-06-10', revenue_brl: 80 },
      { campaign_name: 'pesquisa-institucional', date: '2026-06-11', revenue_brl: 80 },
    ])
    const daily: OverlayableRow[] = [
      row('2026-06-10', 'pesquisa-institucional', 999),
      row('2026-06-11', 'pesquisa-institucional', 999),
    ]
    const result = await applyRevenueOverlay(db, ACCOUNT, daily, '2026-06-10', '2026-06-11')
    expect(daily[0]?.conversion_value).toBe(80)
    expect(daily[1]?.conversion_value).toBe(80)
    expect(result.nRowsOverridden).toBe(2)
    expect(result.realRevenueBrlTotal).toBe(160)
    expect(result.nCacheRows).toBe(2)
    expect(result.cacheFromDate).toBe('2026-06-10')
    expect(result.cacheToDate).toBe('2026-06-11')
  })

  it('campaign_name without a cache row keeps the proxy value', async () => {
    const db = makeFakeDb()
    await seedCache(db, [
      { campaign_name: 'pesquisa-institucional', date: '2026-06-10', revenue_brl: 50 },
    ])
    const daily = [
      row('2026-06-10', 'pesquisa-institucional', 100),
      row('2026-06-10', 'shopping-nb', 200), // not in cache
    ]
    const result = await applyRevenueOverlay(db, ACCOUNT, daily, '2026-06-10', '2026-06-10')
    expect(daily[0]?.conversion_value).toBe(50)
    expect(daily[1]?.conversion_value).toBe(200) // proxy preserved
    expect(result.nRowsOverridden).toBe(1)
  })

  it('account without revenue source config → no-op (cache untouched)', async () => {
    const db = makeFakeDb()
    const daily = [row('2026-06-10', 'X', 999)]
    const result = await applyRevenueOverlay(db, 'unknown-account', daily, '2026-06-10', '2026-06-10')
    expect(daily[0]?.conversion_value).toBe(999)
    expect(result.nCacheRows).toBe(0)
  })

  it('empty cache for the account/window → no-op + logs cache_empty', async () => {
    const db = makeFakeDb()
    // No rows seeded
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    const result = await applyRevenueOverlay(db, ACCOUNT, daily, '2026-06-10', '2026-06-10')
    expect(daily[0]?.conversion_value).toBe(999) // proxy preserved
    expect(result.nCacheRows).toBe(0)
  })

  it('only rows inside [fromDate, toDate] window are pulled', async () => {
    const db = makeFakeDb()
    await seedCache(db, [
      { campaign_name: 'pesquisa-institucional', date: '2026-06-01', revenue_brl: 999 }, // before window
      { campaign_name: 'pesquisa-institucional', date: '2026-06-10', revenue_brl: 80 },  // inside
      { campaign_name: 'pesquisa-institucional', date: '2026-06-20', revenue_brl: 999 }, // after window
    ])
    const daily = [row('2026-06-10', 'pesquisa-institucional', 100)]
    const result = await applyRevenueOverlay(db, ACCOUNT, daily, '2026-06-08', '2026-06-12')
    expect(daily[0]?.conversion_value).toBe(80)
    expect(result.nCacheRows).toBe(1)
    expect(result.cacheFromDate).toBe('2026-06-10')
    expect(result.cacheToDate).toBe('2026-06-10')
  })

  it('rounds the overlaid revenue to 2 decimals (cent precision)', async () => {
    const db = makeFakeDb()
    // Cache writer rounds on upsert; verify the read+apply path also preserves it.
    await seedCache(db, [
      { campaign_name: 'pesquisa-institucional', date: '2026-06-10', revenue_brl: 30.005 },
    ])
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    await applyRevenueOverlay(db, ACCOUNT, daily, '2026-06-10', '2026-06-10')
    // 30.005 → 30.01 (toFixed math)
    expect(daily[0]?.conversion_value).toBe(30.01)
  })
})
