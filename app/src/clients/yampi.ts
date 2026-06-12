// src/clients/yampi.ts
//
// REST client for the Yampi e-commerce platform. We use it to pull the
// ground-truth revenue (per order + per UTM tag) that replaces the
// `conversion_value` proxy from Google Ads.
//
// Auth model: a per-store pair of `User-Token` and `User-Secret-Key`
// headers, set via Godeploy secrets and looked up per account in
// `config/revenueSources.ts`. Base URL slug is the store alias.
//
// API: https://docs.yampi.com.br/

type Fetcher = typeof fetch

const BASE_URL = 'https://api.dooki.com.br/v2'

export interface YampiClientConfig {
  /** URL slug — for Apice: `apice-cosmeticos`. */
  alias: string
  userToken: string
  userSecretKey: string
}

/** One row per order, normalised to what the pipeline needs. Fields outside
 *  this projection are intentionally NOT exposed — clients should not
 *  reach into raw Yampi shapes (those change unannounced). */
export interface YampiOrder {
  /** Yampi internal id. */
  id: number
  /** ISO timestamp (UTC) the order entered `paid` status. */
  paidAt: string | null
  /** Total revenue captured for the order, in BRL. */
  totalBrl: number
  /** UTM tags pulled from the order metadata. Used by the pipeline to
   *  join orders back to a Google Ads campaign. `null` if the metadata
   *  didn't carry the tag (direct traffic, organic, missing utm_*, …). */
  utm: {
    source: string | null
    medium: string | null
    campaign: string | null
    term: string | null
    content: string | null
  }
}

export interface FetchOrdersOptions {
  /** Inclusive ISO date `YYYY-MM-DD`. */
  fromDate: string
  /** Inclusive ISO date `YYYY-MM-DD`. */
  toDate: string
  /** Pagination cap — defaults to 100. Yampi returns a max of 100/page. */
  limit?: number
}

/**
 * Yampi REST client. Wraps `User-Token` + `User-Secret-Key` auth and
 * normalises the relevant fields. The wrapper exists so the pipeline never
 * sees a raw Yampi payload — change-resilience.
 *
 * Construction takes the explicit creds rather than an `Env` so tests can
 * inject without setting fake env bindings.
 */
export class YampiClient {
  private readonly fetcher: Fetcher
  constructor(
    private readonly config: YampiClientConfig,
    fetcher?: Fetcher,
  ) {
    // Same `this`-pinning trick used in GoogleAdsClient: avoid
    // "Illegal invocation" on Cloudflare workers.
    this.fetcher = fetcher ?? ((...args) => fetch(...args))
  }

  private headers(): Record<string, string> {
    return {
      'User-Token': this.config.userToken,
      'User-Secret-Key': this.config.userSecretKey,
      accept: 'application/json',
    }
  }

  /**
   * Fetch paid orders in `[fromDate, toDate]`. Auto-paginates while
   * `has_more` is true. Returns a flat, normalised list (raw shape never
   * leaves this method).
   *
   * Throws on non-2xx. Errors surface the status code + a snippet of the
   * response body for debugging without dumping multi-KB stacktraces.
   */
  async fetchPaidOrders(opts: FetchOrdersOptions): Promise<YampiOrder[]> {
    const limit = opts.limit ?? 100
    const all: YampiOrder[] = []
    let page = 1
    // Yampi pagination: `?page=N&limit=M`. We stop on the first short page.
    // Capped at 50 pages to defend against an infinite loop on a bad API
    // response — 50 × 100 = 5000 orders per range, plenty for a daily run.
    for (; page <= 50; page++) {
      const url =
        `${BASE_URL}/${this.config.alias}/orders` +
        `?include=metadata,transactions` +
        `&status_alias=paid` +
        `&date_min=${encodeURIComponent(opts.fromDate)}` +
        `&date_max=${encodeURIComponent(opts.toDate)}` +
        `&limit=${limit}` +
        `&page=${page}`
      const res = await this.fetcher(url, { method: 'GET', headers: this.headers() })
      if (!res.ok) {
        const snippet = (await res.text()).slice(0, 500)
        throw new Error(`yampi ${res.status}: ${snippet}`)
      }
      const body = (await res.json()) as YampiOrdersResponse
      const data = body.data ?? []
      for (const raw of data) all.push(normaliseOrder(raw))
      if (data.length < limit) break // last page
    }
    return all
  }
}

// ---------------------------------------------------------------------------
// Raw response shape — only the fields we read. The Yampi response includes
// many more nested objects; we intentionally narrow here so the rest of the
// codebase isn't coupled to Yampi's schema.
// ---------------------------------------------------------------------------
interface YampiOrdersResponse {
  data?: YampiOrderRaw[]
  meta?: { current_page?: number; last_page?: number }
}

interface YampiOrderRaw {
  id?: number
  paid_at?: string | null
  /** Some Yampi accounts surface `total` as a number, others as a string —
   *  the normaliser handles both. */
  totals?: { total?: number | string | null } | null
  metadata?: {
    data?: Array<{
      key?: string
      value?: string | null
    }>
  } | null
}

function normaliseOrder(raw: YampiOrderRaw): YampiOrder {
  const totalRaw = raw.totals?.total
  const total =
    typeof totalRaw === 'number'
      ? totalRaw
      : typeof totalRaw === 'string'
        ? Number(totalRaw)
        : 0
  return {
    id: raw.id ?? 0,
    paidAt: raw.paid_at ?? null,
    totalBrl: Number.isFinite(total) ? total : 0,
    utm: extractUtm(raw.metadata?.data ?? []),
  }
}

/** Extract utm_* tags from the metadata list (key/value pairs). */
function extractUtm(items: Array<{ key?: string; value?: string | null }>): YampiOrder['utm'] {
  const out: YampiOrder['utm'] = {
    source: null,
    medium: null,
    campaign: null,
    term: null,
    content: null,
  }
  for (const item of items) {
    const k = (item.key ?? '').toLowerCase()
    const v = item.value ?? null
    if (k === 'utm_source') out.source = v
    else if (k === 'utm_medium') out.medium = v
    else if (k === 'utm_campaign') out.campaign = v
    else if (k === 'utm_term') out.term = v
    else if (k === 'utm_content') out.content = v
  }
  return out
}
