// tests/clients/yampi.test.ts
//
// Yampi REST client — auth, pagination, normalisation, error paths.

import { describe, it, expect, vi } from 'vitest'
import { YampiClient } from '@/clients/yampi'

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
  it('sends User-Token + User-Secret-Key headers + status_alias=paid + date range', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [] }),
    )
    const c = new YampiClient(CFG, fetcher)
    await c.fetchPaidOrders({ fromDate: '2026-06-01', toDate: '2026-06-12' })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toContain('https://api.dooki.com.br/v2/apice-cosmeticos/orders')
    expect(String(url)).toContain('status_alias=paid')
    expect(String(url)).toContain('date_min=2026-06-01')
    expect(String(url)).toContain('date_max=2026-06-12')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['User-Token']).toBe('tok-XYZ')
    expect(headers['User-Secret-Key']).toBe('sk_ABC')
  })

  it('normalises a happy order — total as number, paid_at, utm tags from metadata', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          {
            id: 42,
            paid_at: '2026-06-10T14:00:00Z',
            totals: { total: 199.9 },
            metadata: {
              data: [
                { key: 'utm_source', value: 'google' },
                { key: 'utm_medium', value: 'cpc' },
                { key: 'utm_campaign', value: 'brand-nb' },
              ],
            },
          },
        ],
      }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders).toEqual([
      {
        id: 42,
        paidAt: '2026-06-10T14:00:00Z',
        totalBrl: 199.9,
        utm: {
          source: 'google',
          medium: 'cpc',
          campaign: 'brand-nb',
          term: null,
          content: null,
        },
      },
    ])
  })

  it('parses total as string ("199.90") into a number', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: 1, totals: { total: '199.90' }, metadata: { data: [] } }] }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders[0]?.totalBrl).toBe(199.9)
  })

  it('falls back to 0 total when total is null or non-numeric', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          { id: 1, totals: { total: null }, metadata: { data: [] } },
          { id: 2, totals: { total: 'wat' }, metadata: { data: [] } },
        ],
      }),
    )
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-10', toDate: '2026-06-10' })
    expect(orders[0]?.totalBrl).toBe(0)
    expect(orders[1]?.totalBrl).toBe(0)
  })

  it('utm tags missing → null fields (no crash)', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: 1, totals: { total: 100 }, metadata: { data: [] } }] }),
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

  it('paginates — keeps fetching until a short page', async () => {
    // Page 1: 100 orders (limit) → fetch page 2
    // Page 2: 30 orders (short) → stop
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      totals: { total: 10 },
      metadata: { data: [] },
    }))
    const shortPage = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i + 1,
      totals: { total: 10 },
      metadata: { data: [] },
    }))
    const fetcher = vi.fn<typeof fetch>()
    fetcher.mockResolvedValueOnce(jsonResponse({ data: fullPage }))
    fetcher.mockResolvedValueOnce(jsonResponse({ data: shortPage }))
    const c = new YampiClient(CFG, fetcher)
    const orders = await c.fetchPaidOrders({ fromDate: '2026-06-01', toDate: '2026-06-30' })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(orders).toHaveLength(130)
    // Verify page=1 and page=2 query params appeared on consecutive calls
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
})
