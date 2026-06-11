import { describe, it, expect, vi } from 'vitest'
import { GoogleAdsClient, type GoogleAdsConfig } from '@/clients/googleAds'

const cfg: GoogleAdsConfig = {
  developerToken: 'dev-tok',
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rtok',
  loginCustomerId: '111-222-3333',
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  const ok = init.ok ?? (status >= 200 && status < 300)
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function textResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response
}

function tokenResponse(expiresIn = 3600, accessToken = 'acc-tok'): Response {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn })
}

describe('GoogleAdsClient', () => {
  it('first call refreshes token then calls the endpoint (fetcher called twice)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await client.searchStream('1234567890', 'SELECT campaign.id FROM campaign', 1_000_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token')
    expect(fetcher.mock.calls[1]![0]).toContain('googleAds:searchStream')
  })

  it('token is cached across calls within expiry window', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(3600))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const t0 = 1_000_000
    await client.searchStream('123', 'q1', t0)
    await client.searchStream('123', 'q2', t0 + 1000)
    expect(fetcher).toHaveBeenCalledTimes(3) // 1 token + 2 search (no second token refresh)
    expect(fetcher.mock.calls[2]![0]).toContain('googleAds:searchStream')
  })

  it('refreshes token when nowMs is within 60s of expiry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(3600, 'tok-1'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(tokenResponse(3600, 'tok-2'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const t0 = 0
    await client.searchStream('123', 'q1', t0)
    // expires at t0 + 3600*1000 = 3_600_000 → window opens at 3_540_000.
    // Use 3_600_000 - 30_000 = 3_570_000 which is past the cutoff → refresh.
    await client.searchStream('123', 'q2', 3_570_000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls[2]![0]).toBe('https://oauth2.googleapis.com/token')
    // Verify the second search uses the new token
    const headers2 = (fetcher.mock.calls[3]![1] as RequestInit).headers as Record<string, string>
    expect(headers2.authorization).toBe('Bearer tok-2')
  })

  it('searchStream flattens array-chunked response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse([{ results: ['a', 'b'] }, { results: ['c'] }]),
      )
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const rows = await client.searchStream('123', 'q', 1_000_000)
    expect(rows).toEqual(['a', 'b', 'c'])
  })

  it('searchStream handles single object response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ results: ['x'] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const rows = await client.searchStream('123', 'q', 1_000_000)
    expect(rows).toEqual(['x'])
  })

  it('searchStream missing results key returns empty array', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({}))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const rows = await client.searchStream('123', 'q', 1_000_000)
    expect(rows).toEqual([])
  })

  it('searchStream uses correct URL with version', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await client.searchStream('9876543210', 'SELECT campaign.id FROM campaign', 1_000_000)
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://googleads.googleapis.com/v20/customers/9876543210/googleAds:searchStream',
    )
  })

  it('searchStream uses correct headers and JSON body', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(3600, 'acc-xyz'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await client.searchStream('123', 'SELECT campaign.id FROM campaign', 1_000_000)
    const init = fetcher.mock.calls[1]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer acc-xyz')
    expect(headers['developer-token']).toBe('dev-tok')
    expect(headers['login-customer-id']).toBe('111-222-3333')
    expect(headers['content-type']).toBe('application/json')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'SELECT campaign.id FROM campaign',
    })
  })

  it('mutateBudget posts correct operations array', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ resourceName: 'customers/123/campaignBudgets/9' }] }),
      )
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const out = await client.mutateBudget(
      '123',
      'customers/123/campaignBudgets/9',
      50_000_000,
      1_000_000,
    )
    expect(out).toEqual({ resourceName: 'customers/123/campaignBudgets/9' })
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://googleads.googleapis.com/v20/customers/123/campaignBudgets:mutate',
    )
    const body = JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string)
    expect(body).toEqual({
      operations: [
        {
          update: {
            resourceName: 'customers/123/campaignBudgets/9',
            amountMicros: '50000000',
          },
          updateMask: 'amountMicros',
        },
      ],
    })
    expect(typeof body.operations[0].update.amountMicros).toBe('string')
  })

  it('mutateCampaignTargetRoas posts correct body', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ resourceName: 'customers/123/campaigns/7' }] }),
      )
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    const out = await client.mutateCampaignTargetRoas(
      '123',
      'customers/123/campaigns/7',
      3.5,
      1_000_000,
    )
    expect(out).toEqual({ resourceName: 'customers/123/campaigns/7' })
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://googleads.googleapis.com/v20/customers/123/campaigns:mutate',
    )
    const body = JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string)
    expect(body).toEqual({
      operations: [
        {
          update: {
            resourceName: 'customers/123/campaigns/7',
            maximizeConversionValue: { targetRoas: 3.5 },
          },
          updateMask: 'maximizeConversionValue.targetRoas',
        },
      ],
    })
  })

  it('throws when search returns non-2xx with status in message', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(textResponse('bad query syntax', 400))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await expect(
      client.searchStream('123', 'BAD', 1_000_000),
    ).rejects.toThrow(/googleAds search 400/)
  })

  it('throws when oauth token endpoint returns 401', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(textResponse('invalid_grant', 401))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await expect(
      client.searchStream('123', 'q', 1_000_000),
    ).rejects.toThrow(/google oauth 401/)
  })

  it('throws when mutateBudget returns non-2xx', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(textResponse('forbidden', 403))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await expect(
      client.mutateBudget('123', 'customers/123/campaignBudgets/9', 1000, 1_000_000),
    ).rejects.toThrow(/googleAds mutate budget 403/)
  })

  it('API version override uses v17 in URLs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(
      { ...cfg, apiVersion: 'v17' },
      fetcher as unknown as typeof fetch,
    )
    await client.searchStream('123', 'q', 1_000_000)
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://googleads.googleapis.com/v17/customers/123/googleAds:searchStream',
    )
  })

  it('token refresh body has all required URL-encoded fields', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const client = new GoogleAdsClient(cfg, fetcher as unknown as typeof fetch)
    await client.searchStream('123', 'q', 1_000_000)
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(init.body).toBeInstanceOf(URLSearchParams)
    const params = init.body as URLSearchParams
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('client_id')).toBe('cid')
    expect(params.get('client_secret')).toBe('csecret')
    expect(params.get('refresh_token')).toBe('rtok')
  })
})
