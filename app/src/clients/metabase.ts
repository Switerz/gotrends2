/**
 * Metabase client.
 *
 * Thin wrapper around the Metabase `/api/dataset` native-query endpoint used to
 * pull Apice raw data from the Data Mart. The `fetcher` dependency is injected
 * so unit tests can run hermetically (no real network access).
 */

export interface MetabaseConfig {
  /** Base URL, e.g. "https://metabase.gogroup.tech" (no trailing slash). */
  url: string
  /** API key sent as `x-api-key`. */
  apiKey: string
  /** Data Mart database id. */
  databaseId: number
}

type Fetcher = typeof fetch

interface MetabaseDatasetResponse {
  data: {
    cols: { name: string }[]
    rows: unknown[][]
  }
}

export class MetabaseClient {
  constructor(
    private readonly cfg: MetabaseConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  /**
   * Execute a native SQL query against the configured Metabase database and
   * return the rows as plain objects keyed by column name.
   */
  async querySql<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const res = await this.fetcher(`${this.cfg.url}/api/dataset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
      },
      body: JSON.stringify({
        type: 'native',
        native: { query: sql },
        database: this.cfg.databaseId,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Metabase ${res.status}: ${body.slice(0, 500)}`)
    }
    const json = (await res.json()) as MetabaseDatasetResponse
    const cols = json.data.cols.map((c) => c.name)
    return json.data.rows.map(
      (row) =>
        Object.fromEntries(cols.map((c, i) => [c, row[i]])) as T,
    )
  }
}
