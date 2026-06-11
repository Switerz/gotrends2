export interface GoogleAdsConfig {
  developerToken: string
  clientId: string
  clientSecret: string
  refreshToken: string
  loginCustomerId: string // MCC if applicable, or the customer itself
  apiVersion?: string // default 'v20'
}

type Fetcher = typeof fetch

export class GoogleAdsClient {
  private accessToken: string | null = null
  private tokenExpiresAtMs = 0
  private readonly fetcher: Fetcher

  constructor(
    private cfg: GoogleAdsConfig,
    fetcher?: Fetcher,
  ) {
    // Wrap global fetch in an arrow so the call site never sets `this` to the
    // class instance. Cloudflare Workers' fetch enforces `this === globalThis`
    // and throws `Illegal invocation` otherwise.
    this.fetcher = fetcher ?? ((...args) => fetch(...args))
  }

  private get version(): string {
    return this.cfg.apiVersion ?? 'v20'
  }

  /** Refresh OAuth2 access token via refresh_token grant. Caches until 60s before expiry. */
  private async ensureToken(nowMs: number): Promise<string> {
    if (this.accessToken && nowMs < this.tokenExpiresAtMs - 60_000) {
      return this.accessToken
    }
    const res = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) {
      throw new Error(`google oauth ${res.status}: ${(await res.text()).slice(0, 500)}`)
    }
    const j = (await res.json()) as { access_token: string; expires_in: number }
    this.accessToken = j.access_token
    this.tokenExpiresAtMs = nowMs + j.expires_in * 1000
    return this.accessToken
  }

  private headers(token: string): HeadersInit {
    return {
      authorization: `Bearer ${token}`,
      'developer-token': this.cfg.developerToken,
      'login-customer-id': this.cfg.loginCustomerId,
      'content-type': 'application/json',
    }
  }

  /** searchStream: returns flattened result rows from the streaming endpoint. */
  async searchStream(customerId: string, gaql: string, nowMs = Date.now()): Promise<unknown[]> {
    const tok = await this.ensureToken(nowMs)
    const res = await this.fetcher(
      `https://googleads.googleapis.com/${this.version}/customers/${customerId}/googleAds:searchStream`,
      { method: 'POST', headers: this.headers(tok), body: JSON.stringify({ query: gaql }) },
    )
    if (!res.ok) {
      throw new Error(`googleAds search ${res.status}: ${(await res.text()).slice(0, 500)}`)
    }
    const json = (await res.json()) as unknown
    if (Array.isArray(json)) {
      return json.flatMap((chunk: { results?: unknown[] }) => chunk.results ?? [])
    }
    return (json as { results?: unknown[] }).results ?? []
  }

  /** Mutate a campaign budget amount (micros = cents * 10000). */
  async mutateBudget(
    customerId: string,
    budgetResource: string,
    amountMicros: number,
    nowMs = Date.now(),
  ): Promise<{ resourceName: string }> {
    const tok = await this.ensureToken(nowMs)
    const res = await this.fetcher(
      `https://googleads.googleapis.com/${this.version}/customers/${customerId}/campaignBudgets:mutate`,
      {
        method: 'POST',
        headers: this.headers(tok),
        body: JSON.stringify({
          operations: [
            {
              update: { resourceName: budgetResource, amountMicros: String(amountMicros) },
              updateMask: 'amountMicros',
            },
          ],
        }),
      },
    )
    if (!res.ok) {
      throw new Error(`googleAds mutate budget ${res.status}: ${(await res.text()).slice(0, 500)}`)
    }
    const j = (await res.json()) as { results: { resourceName: string }[] }
    return j.results[0]!
  }

  /** Mutate a campaign's maximize_conversion_value.target_roas. */
  async mutateCampaignTargetRoas(
    customerId: string,
    campaignResource: string,
    targetRoas: number,
    nowMs = Date.now(),
  ): Promise<{ resourceName: string }> {
    const tok = await this.ensureToken(nowMs)
    const res = await this.fetcher(
      `https://googleads.googleapis.com/${this.version}/customers/${customerId}/campaigns:mutate`,
      {
        method: 'POST',
        headers: this.headers(tok),
        body: JSON.stringify({
          operations: [
            {
              update: {
                resourceName: campaignResource,
                maximizeConversionValue: { targetRoas },
              },
              updateMask: 'maximizeConversionValue.targetRoas',
            },
          ],
        }),
      },
    )
    if (!res.ok) {
      throw new Error(
        `googleAds mutate target_roas ${res.status}: ${(await res.text()).slice(0, 500)}`,
      )
    }
    const j = (await res.json()) as { results: { resourceName: string }[] }
    return j.results[0]!
  }
}
