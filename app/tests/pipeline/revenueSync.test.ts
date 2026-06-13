// tests/pipeline/revenueSync.test.ts
//
// Sync helper: chunked Yampi fetch + retry on 429 + upsert into the local
// revenue cache. Uses a fake Yampi client to drive every branch.

import { describe, it, expect, vi } from 'vitest'
import { syncRevenueRange } from '@/pipeline/revenueSync'
import { CampaignRevenueRepo } from '@/db/repos/campaignRevenue'
import { YampiClient, type YampiOrder } from '@/clients/yampi'
import { makeFakeDb } from '../db/repos/_fakeDb'
import type { Env } from '@/index'

const ACCOUNT = '7705857660'

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: {} as Env['DB'],
    YAMPI_APICE_USER_TOKEN: 'tok',
    YAMPI_APICE_USER_SECRET_KEY: 'sk',
    ...over,
  } as Env
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

function clientReturning(orders: YampiOrder[]): YampiClient {
  return {
    fetchPaidOrders: vi.fn(async () => orders),
  } as unknown as YampiClient
}

describe('syncRevenueRange', () => {
  it('aggregates google orders by (campaign, date) and upserts the cache', async () => {
    const db = makeFakeDb()
    const result = await syncRevenueRange(
      makeEnv(),
      db,
      ACCOUNT,
      '2026-06-10',
      '2026-06-10',
      () =>
        clientReturning([
          order({ id: 1, totalBrl: 50, createdAt: '2026-06-10 09:00:00' }),
          order({ id: 2, totalBrl: 30, createdAt: '2026-06-10 14:00:00' }),
          // Different campaign on the same day
          order({
            id: 3,
            totalBrl: 75,
            createdAt: '2026-06-10 18:00:00',
            utm: { source: 'google', medium: 'cpc', campaign: 'shopping-nb', term: null, content: null },
          }),
        ]),
    )
    expect(result.rowsUpserted).toBe(2) // 2 unique (campaign, day) tuples
    expect(result.ordersAggregated).toBe(3)
    expect(result.errors).toEqual([])

    // Verify via repo round-trip
    const repo = new CampaignRevenueRepo(db)
    const rows = await repo.listByAccountAndDateRange(ACCOUNT, '2026-06-10', '2026-06-10')
    expect(rows).toHaveLength(2)
    const pesquisa = rows.find((r) => r.campaign_name === 'pesquisa-institucional')
    expect(pesquisa?.revenue_brl).toBe(80)
    expect(pesquisa?.n_orders).toBe(2)
    expect(pesquisa?.provider).toBe('yampi')
  })

  it('drops non-google orders + orders without utm_campaign', async () => {
    const db = makeFakeDb()
    const result = await syncRevenueRange(
      makeEnv(),
      db,
      ACCOUNT,
      '2026-06-10',
      '2026-06-10',
      () =>
        clientReturning([
          order({ utm: { ...order().utm, source: 'facebook' } }), // not google
          order({ utm: { ...order().utm, campaign: null } }), // no campaign tag
          order({ id: 99, totalBrl: 200 }), // valid google rec
        ]),
    )
    expect(result.ordersAggregated).toBe(1)
    expect(result.rowsUpserted).toBe(1)
  })

  it('account without config → no-op (provider stays null)', async () => {
    const db = makeFakeDb()
    const factory = vi.fn()
    const result = await syncRevenueRange(
      makeEnv(),
      db,
      'unknown-account',
      '2026-06-10',
      '2026-06-10',
      factory as never,
    )
    expect(result.provider).toBeNull()
    expect(result.rowsUpserted).toBe(0)
    expect(factory).not.toHaveBeenCalled()
  })

  it('missing credentials → no-op (graceful skip + log)', async () => {
    const db = makeFakeDb()
    const factory = vi.fn()
    const result = await syncRevenueRange(
      makeEnv({ YAMPI_APICE_USER_TOKEN: undefined }),
      db,
      ACCOUNT,
      '2026-06-10',
      '2026-06-10',
      factory as never,
    )
    expect(result.provider).toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('retries on 429 with backoff and eventually succeeds', async () => {
    const db = makeFakeDb()
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('yampi 429: Too Many Attempts'))
      .mockResolvedValueOnce([order({ totalBrl: 42 })])
    const fakeClient = { fetchPaidOrders: fetchSpy } as unknown as YampiClient
    const result = await syncRevenueRange(
      makeEnv(),
      db,
      ACCOUNT,
      '2026-06-10',
      '2026-06-10',
      () => fakeClient,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.errors).toEqual([])
    expect(result.rowsUpserted).toBe(1)
  }, 10_000)

  it('non-429 errors are not retried — surface to errors[] and continue', async () => {
    const db = makeFakeDb()
    const fakeClient = {
      fetchPaidOrders: vi.fn(async () => {
        throw new Error('yampi 401: Unauthorized')
      }),
    } as unknown as YampiClient
    const result = await syncRevenueRange(
      makeEnv(),
      db,
      ACCOUNT,
      '2026-06-10',
      '2026-06-10',
      () => fakeClient,
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.error).toMatch(/401/)
    expect(result.rowsUpserted).toBe(0)
  })

  it('aggregates across chunks when the range spans multiple days', async () => {
    // 3-day window, CHUNK_DAYS=1 in revenueSync → 3 chunks
    const db = makeFakeDb()
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce([order({ createdAt: '2026-06-08 10:00:00', totalBrl: 10 })])
      .mockResolvedValueOnce([order({ createdAt: '2026-06-09 10:00:00', totalBrl: 20 })])
      .mockResolvedValueOnce([order({ createdAt: '2026-06-10 10:00:00', totalBrl: 30 })])
    const fakeClient = { fetchPaidOrders: fetchSpy } as unknown as YampiClient
    const result = await syncRevenueRange(
      makeEnv(),
      db,
      ACCOUNT,
      '2026-06-08',
      '2026-06-10',
      () => fakeClient,
    )
    expect(result.windowsScanned).toBe(3)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(result.ordersAggregated).toBe(3)
    expect(result.rowsUpserted).toBe(3) // one (campaign,date) per day
  })

  it('rounds upserted revenue to cents', async () => {
    const db = makeFakeDb()
    await syncRevenueRange(
      makeEnv(),
      db,
      ACCOUNT,
      '2026-06-10',
      '2026-06-10',
      () =>
        clientReturning([
          order({ totalBrl: 10.001 }),
          order({ totalBrl: 20.004 }),
        ]),
    )
    const repo = new CampaignRevenueRepo(db)
    const rows = await repo.listByAccountAndDateRange(ACCOUNT, '2026-06-10', '2026-06-10')
    // 30.005 → 30.01 (banker's rounding via Math.round)
    expect(rows[0]?.revenue_brl).toBe(30.01)
  })
})
