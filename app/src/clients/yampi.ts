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

/**
 * Days per sub-range when auto-chunking. Sized for the heaviest tenant we
 * operate (Apice ~3.5k orders/day across all sources) so that 2 days fits
 * comfortably under Yampi's 10k-record per-range ceiling (~7k orders).
 * Larger windows risk truncation; smaller windows multiply the calls.
 */
const CHUNK_DAYS = 2

/** Pause between sequential chunk requests, in ms. Yampi rate-limits
 *  aggressive callers with 429 ("Too Many Attempts") — empirically, 250ms
 *  per request keeps a 60-day pull (~30 chunks) under the threshold. */
const CHUNK_DELAY_MS = 250

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
  /** ISO datetime the order was created (`raw.created_at.date`, server tz).
   *  Used by the pipeline to attribute revenue to a calendar day. The
   *  `paid_at` field is not exposed top-level by the Yampi orders list
   *  endpoint; created_at within `status_alias=paid` is a close enough
   *  proxy and avoids a per-order transactions lookup. */
  createdAt: string | null
  /** `value_total` from the Yampi payload — the final figure paid by the
   *  customer in BRL, net of discounts and including shipping. This is the
   *  ground-truth revenue replacement for Google Ads `conversion_value`. */
  totalBrl: number
  /** UTM tags pulled from the order's top-level fields (Yampi exposes them
   *  directly, not nested under `metadata`). Used by the pipeline to join
   *  orders back to a Google Ads campaign. `null` when the order's URL
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
   * Fetch paid orders in `[fromDate, toDate]`. Auto-paginates per single
   * range; auto-chunks the date range when the projected order count
   * would blow past Yampi's 10 000-record offset ceiling.
   *
   * The chunk size of 7 days fits Apice's volume (~950 orders/day Google
   * Ads + ~3500/day across all sources = ~6.5k/chunk, leaving headroom)
   * and keeps the parallel fan-out small. If another tenant has higher
   * volume, lower the chunk size — it composes.
   *
   * Throws on non-2xx. Errors surface the status code + a snippet of the
   * response body for debugging without dumping multi-KB stacktraces.
   */
  async fetchPaidOrders(opts: FetchOrdersOptions): Promise<YampiOrder[]> {
    const chunks = chunkDateRange(opts.fromDate, opts.toDate, CHUNK_DAYS)
    if (chunks.length === 1) {
      return this.fetchPaidOrdersSinglePage(opts)
    }
    // Sequential with a small inter-chunk delay — Yampi 429s aggressive
    // callers even with serial requests if they come back-to-back. The
    // overall cron is non-interactive so a 250ms gap × 30 chunks (~7.5s)
    // is fine; trying to optimise this further fights the API and loses.
    const all: YampiOrder[] = []
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(CHUNK_DELAY_MS)
      const c = chunks[i]!
      const list = await this.fetchPaidOrdersSinglePage({
        fromDate: c.fromDate,
        toDate: c.toDate,
        limit: opts.limit,
      })
      all.push(...list)
    }
    return all
  }

  private async fetchPaidOrdersSinglePage(opts: FetchOrdersOptions): Promise<YampiOrder[]> {
    const limit = opts.limit ?? 100
    const all: YampiOrder[] = []
    let page = 1
    // Yampi pagination: `?page=N&limit=M`. We stop on the first short page.
    // Capped at 50 pages to defend against an infinite loop on a bad API
    // response — 50 × 100 = 5000 orders per range, plenty for a daily run.
    //
    // No `include=...` needed: utm_* + value_total + created_at are all
    // top-level fields in the default projection. Adding includes would
    // bloat the payload with cart/items/customer/etc. that we don't use.
    //
    // Yampi enforces a HARD ceiling of 10 000 records per range (any page
    // whose offset = (page-1) × limit ≥ 10 000 returns
    // `400 {"message":"Maximum limit is 10000"}`). With limit=100 that
    // bottoms out at exactly 100 pages, which is our cap here. If a range
    // really has > 10k orders, the operator must split the window — we
    // log loudly when the cap clips so it doesn't go unnoticed.
    const MAX_PAGES = 100
    let hitCap = false
    for (; page <= MAX_PAGES; page++) {
      const url =
        `${BASE_URL}/${this.config.alias}/orders` +
        `?status_alias=paid` +
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
      if (page === MAX_PAGES) hitCap = true
    }
    if (hitCap) {
      // Loud log so operators see when the pagination ceiling clipped data.
      // Not thrown — we still return the partial set so the pipeline runs.
      console.log(
        JSON.stringify({
          event: 'yampi_pagination_cap_hit',
          alias: this.config.alias,
          maxPages: MAX_PAGES,
          limit,
          ordersReturned: all.length,
          fromDate: opts.fromDate,
          toDate: opts.toDate,
        }),
      )
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
  /** Yampi wraps timestamps as { date, timezone, timezone_type }. We read
   *  the `date` string only — the timezone field is "America/Sao_Paulo" on
   *  every order we've seen so canonicalising costs no information. */
  created_at?: { date?: string } | null
  /** Final order total in BRL (net of discounts, including shipping).
   *  Yampi sometimes ships this as a number, sometimes as a string. */
  value_total?: number | string | null
  /** UTM tags appear as top-level fields on the order, NOT nested inside
   *  metadata. Confirmed against the live API on 2026-06-12. */
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_term?: string | null
  utm_content?: string | null
}

/**
 * Split `[from, to]` (inclusive, `YYYY-MM-DD`) into consecutive
 * sub-ranges of at most `chunkDays` days each. Returns `[{from, to}, …]`
 * sorted oldest-first. Sub-ranges are also inclusive — the helper makes
 * sure no day is covered twice.
 *
 * Boundary calculation in pure date math (no Date arithmetic that would
 * sneak in TZ surprises) — both inputs and outputs are `YYYY-MM-DD`.
 */
export function chunkDateRange(
  fromDate: string,
  toDate: string,
  chunkDays: number,
): Array<{ fromDate: string; toDate: string }> {
  if (chunkDays <= 0) {
    throw new Error(`chunkDateRange: chunkDays must be > 0, got ${chunkDays}`)
  }
  const fromMs = Date.parse(`${fromDate}T00:00:00Z`)
  const toMs = Date.parse(`${toDate}T00:00:00Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`chunkDateRange: invalid date(s) ${fromDate}..${toDate}`)
  }
  if (toMs < fromMs) {
    throw new Error(`chunkDateRange: toDate before fromDate (${fromDate} > ${toDate})`)
  }
  const out: Array<{ fromDate: string; toDate: string }> = []
  const dayMs = 24 * 3600 * 1000
  for (let cursor = fromMs; cursor <= toMs; cursor += chunkDays * dayMs) {
    const endMs = Math.min(cursor + (chunkDays - 1) * dayMs, toMs)
    out.push({
      fromDate: new Date(cursor).toISOString().slice(0, 10),
      toDate: new Date(endMs).toISOString().slice(0, 10),
    })
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normaliseOrder(raw: YampiOrderRaw): YampiOrder {
  const v = raw.value_total
  const total =
    typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0
  return {
    id: raw.id ?? 0,
    createdAt: raw.created_at?.date ?? null,
    totalBrl: Number.isFinite(total) ? total : 0,
    utm: {
      source: raw.utm_source ?? null,
      medium: raw.utm_medium ?? null,
      campaign: raw.utm_campaign ?? null,
      term: raw.utm_term ?? null,
      content: raw.utm_content ?? null,
    },
  }
}
