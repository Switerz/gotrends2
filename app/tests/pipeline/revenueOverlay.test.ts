// tests/pipeline/revenueOverlay.test.ts
//
// Revenue overlay: ground-truth e-commerce revenue replaces the Google-Ads
// `conversion_value` proxy in-place on daily rows. Edge cases here matter
// because every downstream model (baseline, elasticity, COS) consumes the
// overlay output.

import { describe, it, expect, vi } from 'vitest'
import { applyRevenueOverlay, type OverlayableRow } from '@/pipeline/revenueOverlay'
import { YampiClient, type YampiOrder } from '@/clients/yampi'
import type { Env } from '@/index'

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {} as Env['DB'],
    YAMPI_APICE_USER_TOKEN: 'tok',
    YAMPI_APICE_USER_SECRET_KEY: 'sk',
    ...over,
  } as Env
}

function mockClient(orders: YampiOrder[]): YampiClient {
  return {
    fetchPaidOrders: vi.fn(async () => orders),
  } as unknown as YampiClient
}

function row(
  date: string,
  campaign_name: string,
  conversion_value: number,
): OverlayableRow {
  return { date, campaign_name, conversion_value }
}

function order(over: Partial<YampiOrder> = {}): YampiOrder {
  return {
    id: 1,
    createdAt: '2026-06-10 14:00:00.000000',
    totalBrl: 100,
    utm: {
      source: 'google',
      medium: 'cpc',
      campaign: 'pesquisa-institucional',
      term: null,
      content: null,
    },
    ...over,
  }
}

const ACCOUNT = '7705857660'

describe('applyRevenueOverlay', () => {
  it('overlays Google Ads orders onto matching (date, campaign_name) rows', async () => {
    const orders = [
      order({ id: 1, totalBrl: 50, createdAt: '2026-06-10 10:00:00' }),
      order({ id: 2, totalBrl: 30, createdAt: '2026-06-10 14:00:00' }),
      order({ id: 3, totalBrl: 80, createdAt: '2026-06-11 09:00:00' }),
    ]
    const daily: OverlayableRow[] = [
      row('2026-06-10', 'pesquisa-institucional', 999),
      row('2026-06-11', 'pesquisa-institucional', 999),
    ]
    const result = await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-11',
      () => mockClient(orders),
    )
    // 2026-06-10 → 50 + 30 = 80 ; 2026-06-11 → 80
    expect(daily[0]?.conversion_value).toBe(80)
    expect(daily[1]?.conversion_value).toBe(80)
    expect(result.nRowsOverridden).toBe(2)
    expect(result.realRevenueBrlTotal).toBe(160)
    expect(result.nOrdersFromGoogleAds).toBe(3)
  })

  it('drops non-google orders (Meta / Insider / etc.)', async () => {
    const orders = [
      order({ id: 1, utm: { ...order().utm, source: 'facebook' } }),
      order({ id: 2, utm: { ...order().utm, source: 'insider' } }),
      order({ id: 3, utm: { ...order().utm, source: 'google' }, totalBrl: 200 }),
    ]
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    const result = await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => mockClient(orders),
    )
    expect(daily[0]?.conversion_value).toBe(200)
    expect(result.nOrdersFromGoogleAds).toBe(1)
    expect(result.nOrdersFetched).toBe(3)
  })

  it('drops google orders without utm_campaign (direct google traffic without tag)', async () => {
    const orders = [
      order({ id: 1, utm: { ...order().utm, campaign: null } }),
      order({ id: 2, totalBrl: 75 }),
    ]
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    const result = await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => mockClient(orders),
    )
    expect(daily[0]?.conversion_value).toBe(75)
    expect(result.nOrdersWithoutCampaign).toBe(1)
  })

  it('campaign_name without orders keeps the proxy value (no override)', async () => {
    const daily = [
      row('2026-06-10', 'pesquisa-institucional', 100),
      row('2026-06-10', 'shopping-nb', 200), // not in orders
    ]
    const result = await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => mockClient([order({ totalBrl: 50 })]),
    )
    expect(daily[0]?.conversion_value).toBe(50)
    expect(daily[1]?.conversion_value).toBe(200)
    expect(result.nRowsOverridden).toBe(1)
  })

  it('account without revenue source config → no-op', async () => {
    const daily = [row('2026-06-10', 'X', 999)]
    const factory = vi.fn()
    const result = await applyRevenueOverlay(
      makeEnv(),
      'unknown-account',
      daily,
      '2026-06-10',
      '2026-06-10',
      factory as never,
    )
    expect(daily[0]?.conversion_value).toBe(999) // untouched
    expect(result.nOrdersFetched).toBe(0)
    expect(factory).not.toHaveBeenCalled()
  })

  it('missing credentials → no-op (graceful skip, structured log)', async () => {
    const daily = [row('2026-06-10', 'X', 999)]
    const factory = vi.fn()
    const result = await applyRevenueOverlay(
      makeEnv({ YAMPI_APICE_USER_TOKEN: undefined }),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      factory as never,
    )
    expect(daily[0]?.conversion_value).toBe(999)
    expect(result.nOrdersFetched).toBe(0)
    expect(factory).not.toHaveBeenCalled()
  })

  it('fetch failure → no-op (NEVER throws — pipeline keeps running on proxy)', async () => {
    const failing = {
      fetchPaidOrders: async () => {
        throw new Error('yampi 401: bad token')
      },
    } as unknown as YampiClient
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    const result = await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => failing,
    )
    expect(daily[0]?.conversion_value).toBe(999) // proxy preserved
    expect(result.nOrdersFetched).toBe(0)
  })

  it('createdAt only contributes the YYYY-MM-DD prefix to the key', async () => {
    // Two orders on the same day, different hours → both aggregate to the
    // same row.
    const orders = [
      order({ id: 1, createdAt: '2026-06-10 09:00:00.000000', totalBrl: 10 }),
      order({ id: 2, createdAt: '2026-06-10 23:59:59.999999', totalBrl: 20 }),
    ]
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => mockClient(orders),
    )
    expect(daily[0]?.conversion_value).toBe(30)
  })

  it('null createdAt drops the order (cannot place on a calendar day)', async () => {
    const orders = [order({ createdAt: null, totalBrl: 999 })]
    const daily = [row('2026-06-10', 'pesquisa-institucional', 100)]
    const result = await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => mockClient(orders),
    )
    expect(daily[0]?.conversion_value).toBe(100) // unchanged
    expect(result.nRowsOverridden).toBe(0)
  })

  it('rounds the overlaid revenue to 2 decimals (cent precision)', async () => {
    const orders = [
      order({ totalBrl: 10.001 }),
      order({ totalBrl: 20.004 }),
    ]
    const daily = [row('2026-06-10', 'pesquisa-institucional', 999)]
    await applyRevenueOverlay(
      makeEnv(),
      ACCOUNT,
      daily,
      '2026-06-10',
      '2026-06-10',
      () => mockClient(orders),
    )
    expect(daily[0]?.conversion_value).toBe(30.01)
  })
})
