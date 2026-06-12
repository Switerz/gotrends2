// tests/clients/yampi.test.ts
//
// Yampi REST client — auth, pagination, normalisation, error paths.
// Shape validated against the live API on 2026-06-12: utm_* are top-level
// fields on the order, value_total is the net amount in BRL, created_at is
// a wrapped { date } object.

import { describe, it, expect, vi } from 'vitest'
import { YampiClient, chunkDateRange } from '@/clients/yampi'

const CFG = {
  alias: 'apice-cosmeticos',
  userToken: 'tok-XYZ',
  userSecretKey: 'sk_ABC',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('YampiClient.fetchPaidOrders', () => {
  it('sends User-Token + User-Secret-Key headers + status_alias=paid + date range, no extra includes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }))
    const c = new YampiClient(CFG, fetcher)
    // Single-day range stays inside one chunk so we get exactly one fetch.
    await c.fetchPaidOrders({ fromDate: '2026-06-12', toDate: '2026-06-12' })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    const urlStr = String(url)
    expect(urlStr).toContain('https://api.dooki.com.br/v2/apice-cosmeticos/orders')
    expect(urlStr).toContain('status_alias=paid')
    expect(urlStr).toContain('date_min=2026-06-12')
    expect(urlStr).toContain('date_max=2026-06-12')
    // We rely on the default projection — adding ?include= would bloat the
    // payload with cart/items/customer that we don't read.
    expect(urlStr).not.toContain('include=')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['User-Token']).toBe('tok-XYZ')
    expect(headers['User-Secret-Key']).toBe('sk_ABC')
  })

  it('normalises a real-shape order — top-level utm_*, value_total, created_at.date', async () => {
    // Payload mirrors the actual Yampi response we probed on 2026-06-12.
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: 164823846,
            created_at: { date: '2026-06-12 15:00:12.000000' },
            updated_at: { date: '2026-06-12 15:01:47.000000' },
            value_products: 226.71,
            value_discount: 37.18,
            value_shipment: 11.9,
            value_total: 201.43,
            utm_source: 'facebook',
            utm_medium: 'paid',
            utm_campaign: 'Conversão - Valor - CUPOM',
            utm_content: 'video-creative-x',
            utm_term: '120221002675910393',
          },
        ],
      }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-12', toDate: '2026-06-12' })
    expect(orders).toEqual([
      {
        id: 164823846,
        createdAt: '2026-06-12 15:00:12.000000',
        totalBrl: 201.43,
        utm: {
          source: 'facebook',
          medium: 'paid',
          campaign: 'Conversão - Valor - CUPOM',
          term: '120221002675910393',
          content: 'video-creative-x',
        },
      },
    ])
  })

  it('parses value_total as string ("201.43") into a number', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: 1, value_total: '201.43' }] }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders[0]?.totalBrl).toBe(201.43)
  })

  it('falls back to 0 when value_total is null or non-numeric', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          { id: 1, value_total: null },
          { id: 2, value_total: 'wat' },
        ],
      }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders[0]?.totalBrl).toBe(0)
    expect(orders[1]?.totalBrl).toBe(0)
  })

  it('orders with no UTM tags → all utm fields null (organic / direct traffic)', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: 1, value_total: 100, created_at: { date: '2026-06-10 10:00:00' } }] }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders[0]?.utm).toEqual({
      source: null,
      medium: null,
      campaign: null,
      term: null,
      content: null,
    })
  })

  it('missing created_at → createdAt is null (rare, defensive)', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: 1, value_total: 100 }] }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders[0]?.createdAt).toBeNull()
  })

  it('paginates within a chunk — keeps fetching pages until a short page', async () => {
    // Single-day range keeps the chunker at exactly one chunk so we can
    // observe pure pagination behaviour.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      value_total: 10,
    }))
    const shortPage = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i + 1,
      value_total: 10,
    }))
    const fetcher = vi.fn<typeof fetch>()
    fetcher.mockResolvedValueOnce(jsonResponse({ data: fullPage }))
    fetcher.mockResolvedValueOnce(jsonResponse({ data: shortPage }))
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-12', toDate: '2026-06-12' })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(orders).toHaveLength(130)
    expect(String(fetcher.mock.calls[0]![0])).toContain('page=1')
    expect(String(fetcher.mock.calls[1]![0])).toContain('page=2')
  })

  it('empty data array → returns empty list, single fetch call', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }))
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders).toEqual([])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('throws on non-2xx with status code + body snippet', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response('Unauthorized: bad token', { status: 401 }),
    )
    const c = new YampiClient(CFG, fetcher)
    await expect(
      c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' }),
    ).rejects.toThrow(/yampi 401/)
  })

  it('honours custom limit param', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }))
    const c = new YampiClient(CFG, fetcher)
    await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10', limit: 25 })
    expect(String(fetcher.mock.calls[0]![0])).toContain('limit=25')
  })

  it('auto-chunks ranges that span beyond CHUNK_DAYS — multiple sequential fetches', async () => {
    // 6-day window, CHUNK_DAYS=2 → 3 chunks.
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }))
    const c = new YampiClient(CFG, fetcher)
    await c.fetchPaidOrders({ fromDate: '2026-06-07', toDate: '2026-06-12' })

    expect(fetcher).toHaveBeenCalledTimes(3)
    const dateMins = fetcher.mock.calls.map((call) => {
      const u = new URL(String(call[0]))
      return u.searchParams.get('date_min')
    })
    expect(dateMins).toEqual([
      '2026-06-07',
      '2026-06-09',
      '2026-06-11',
    ])
  })

  it('single-day or single-chunk range → no extra fan-out', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }))
    const c = new YampiClient(CFG, fetcher)
    await c.fetchPaidOrders({ fromDate: '2026-06-12', toDate: '2026-06-12' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('chunkDateRange', () => {
  it('splits a 6-day window into 3 chunks of ≤2 days each (chunkDays=2)', () => {
    const chunks = chunkDateRange('2026-06-07', '2026-06-12', 2)
    expect(chunks).toEqual([
      { fromDate: '2026-06-07', toDate: '2026-06-08' },
      { fromDate: '2026-06-09', toDate: '2026-06-10' },
      { fromDate: '2026-06-11', toDate: '2026-06-12' },
    ])
  })

  it('returns a single chunk when the range fits within chunkDays', () => {
    expect(chunkDateRange('2026-06-12', '2026-06-12', 7)).toEqual([
      { fromDate: '2026-06-12', toDate: '2026-06-12' },
    ])
    expect(chunkDateRange('2026-06-08', '2026-06-12', 7)).toEqual([
      { fromDate: '2026-06-08', toDate: '2026-06-12' },
    ])
  })

  it('short tail when chunk size does not divide evenly', () => {
    // 5 days, chunk=2 → 2 full chunks + 1 short (1 day)
    expect(chunkDateRange('2026-06-08', '2026-06-12', 2)).toEqual([
      { fromDate: '2026-06-08', toDate: '2026-06-09' },
      { fromDate: '2026-06-10', toDate: '2026-06-11' },
      { fromDate: '2026-06-12', toDate: '2026-06-12' },
    ])
  })

  it('throws on invalid input — chunkDays ≤ 0, reversed range, malformed dates', () => {
    expect(() => chunkDateRange('2026-06-01', '2026-06-14', 0)).toThrow(/chunkDays/)
    expect(() => chunkDateRange('2026-06-14', '2026-06-01', 7)).toThrow(/before/)
    expect(() => chunkDateRange('not-a-date', '2026-06-14', 7)).toThrow(/invalid/)
  })
})
