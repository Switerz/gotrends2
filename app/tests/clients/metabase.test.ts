import { describe, it, expect, vi } from 'vitest'
import { MetabaseClient, type MetabaseConfig } from '@/clients/metabase'

const baseCfg: MetabaseConfig = {
  url: 'https://metabase.example.test',
  apiKey: 'secret-key-123',
  databaseId: 42,
}

/** Build a mock Response-like object that satisfies the bits the client uses. */
function makeResponse(opts: {
  ok?: boolean
  status?: number
  jsonBody?: unknown
  textBody?: string
}): Response {
  const ok = opts.ok ?? true
  const status = opts.status ?? (ok ? 200 : 500)
  return {
    ok,
    status,
    json: async () => opts.jsonBody,
    text: async () => opts.textBody ?? '',
  } as unknown as Response
}

describe('MetabaseClient', () => {
  it('happy path: parses cols/rows into array of objects with correct keys/values', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({
        jsonBody: {
          data: {
            cols: [{ name: 'id' }, { name: 'name' }],
            rows: [
              [1, 'apice'],
              [2, 'gogroup'],
            ],
          },
        },
      }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    const rows = await client.querySql('SELECT id, name FROM accounts')

    expect(rows).toEqual([
      { id: 1, name: 'apice' },
      { id: 2, name: 'gogroup' },
    ])
  })

  it('POSTs to <url>/api/dataset with correct method, content-type, and x-api-key', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({ jsonBody: { data: { cols: [], rows: [] } } }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    await client.querySql('SELECT 1')

    expect(fetcher).toHaveBeenCalledTimes(1)
    const call = fetcher.mock.calls[0]!
    const [url, init] = call as [string, RequestInit]

    expect(url).toBe('https://metabase.example.test/api/dataset')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-api-key']).toBe('secret-key-123')
  })

  it('POST body has type=native, native.query, and database=<id>', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({ jsonBody: { data: { cols: [], rows: [] } } }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    const sql = 'SELECT count(*) FROM apice_daily'
    await client.querySql(sql)

    const call = fetcher.mock.calls[0]!
    const init = call[1] as RequestInit
    const parsed = JSON.parse(init.body as string) as {
      type: string
      native: { query: string }
      database: number
    }
    expect(parsed.type).toBe('native')
    expect(parsed.native.query).toBe(sql)
    expect(parsed.database).toBe(42)
  })

  it('throws with status and body snippet on HTTP 500', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({
        ok: false,
        status: 500,
        textBody: 'internal server error: query timeout',
      }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)

    await expect(client.querySql('SELECT 1')).rejects.toThrow(
      /Metabase 500: internal server error: query timeout/,
    )
  })

  it('truncates very long error bodies to 500 chars', async () => {
    const longBody = 'x'.repeat(2000)
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({ ok: false, status: 502, textBody: longBody }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)

    await expect(client.querySql('SELECT 1')).rejects.toThrow(
      new RegExp(`^Metabase 502: x{500}$`),
    )
  })

  it('empty result: rows=[] returns []', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({
        jsonBody: {
          data: {
            cols: [{ name: 'id' }],
            rows: [],
          },
        },
      }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    const rows = await client.querySql('SELECT id FROM empty_table')
    expect(rows).toEqual([])
  })

  it('generic <T> narrows row shape at the type level', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({
        jsonBody: {
          data: {
            cols: [{ name: 'id' }, { name: 'name' }],
            rows: [[7, 'apice']],
          },
        },
      }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    const rows = await client.querySql<{ id: number; name: string }>(
      'SELECT id, name FROM accounts',
    )
    // Type-level assertions: these compile only when T is honored.
    const first = rows[0]!
    const idCheck: number = first.id
    const nameCheck: string = first.name
    expect(idCheck).toBe(7)
    expect(nameCheck).toBe('apice')
  })

  it('SQL with quotes and newlines round-trips through JSON.stringify', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({ jsonBody: { data: { cols: [], rows: [] } } }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    const sql = `SELECT *
FROM "accounts"
WHERE name = 'O''Brien' AND note = "a\\nb"`
    await client.querySql(sql)

    const init = fetcher.mock.calls[0]![1] as RequestInit
    const parsed = JSON.parse(init.body as string) as {
      native: { query: string }
    }
    expect(parsed.native.query).toBe(sql)
  })

  it('aligns multiple columns and rows correctly', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeResponse({
        jsonBody: {
          data: {
            cols: [
              { name: 'campaign_id' },
              { name: 'spend' },
              { name: 'roas' },
              { name: 'active' },
            ],
            rows: [
              ['c1', 100.5, 2.3, true],
              ['c2', 0, null, false],
              ['c3', 250.0, 1.1, true],
            ],
          },
        },
      }),
    )
    const client = new MetabaseClient(baseCfg, fetcher)
    const rows = await client.querySql('SELECT * FROM perf')
    expect(rows).toEqual([
      { campaign_id: 'c1', spend: 100.5, roas: 2.3, active: true },
      { campaign_id: 'c2', spend: 0, roas: null, active: false },
      { campaign_id: 'c3', spend: 250.0, roas: 1.1, active: true },
    ])
  })

  it('uses the global fetch when no fetcher is injected (smoke check on constructor default)', () => {
    // Just verifies construction with a single arg compiles and does not throw.
    const client = new MetabaseClient(baseCfg)
    expect(client).toBeInstanceOf(MetabaseClient)
  })
})
