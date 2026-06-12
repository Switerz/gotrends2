type Fetcher = typeof fetch

// ---- Card builder (pure) ----

export interface RecommendationCardInput {
  recommendationId: string
  headline: string
  campaign: string
  changePercent: number | null
  expectedRevenueBrl: number | null
  expectedCostBrl: number | null
  marginalRoas: number | null
  confidence: number | null
  risk: string | null
  guardrailStatus: 'ok' | 'needs_human_review' | 'blocked'
  /**
   * Cumulative tROAS drift snapshot for the campaign at card-build time.
   * Renders an extra widget showing consumption against both caps so the
   * operator can decide from the Chat without opening the SPA. Omit for
   * non-tROAS actions or when the snapshot is unavailable — the widget
   * is then not rendered, no placeholder noise.
   */
  troasDrift?: {
    todayPct: number
    sevenDayPct: number
    dailyCapPct: number
    sevenDayCapPct: number
    proposedDeltaPct: number
  } | null
}

// PT-BR labels surfaced on the card. Unknown values fall through so a new
// enum from the model never silently disappears from the card.
const GUARDRAIL_LABELS: Record<string, string> = {
  ok: 'OK',
  needs_human_review: 'Revisão humana',
  blocked: 'Bloqueado',
}

const RISK_LABELS: Record<string, string> = {
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
}

/**
 * Capitalized PT-BR labels for the recommended_action enum, used in card
 * headlines. The agent module has its own lowercase variant for narrative
 * text — kept distinct so neither callsite needs to .toUpperCase() the other.
 */
export const ACTION_LABELS_CARD: Record<string, string> = {
  increase_budget: 'Aumentar budget',
  reduce_budget: 'Reduzir budget',
  increase_troas_or_reduce_budget: 'Aumentar tROAS ou reduzir budget',
  optimize_efficiency: 'Otimizar eficiência',
  improve_ads_or_terms: 'Melhorar anúncios ou termos',
  review_landing_or_offer: 'Revisar landing ou oferta',
  monitor: 'Monitorar',
  pause: 'Pausar',
}

/** Formats a BRL value: 1234.56 → "R$ 1.234,56"; null → "—". */
function fmtBrl(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v).toFixed(2)
  const [intPart, dec] = abs.split('.')
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}R$ ${grouped},${dec}`
}

/** Formats a percentage from a ratio: 0.123 → "12,3%"; null → "—". */
function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(1).replace('.', ',')}%`
}

/**
 * Render the tROAS cap consumption in a compact single line. The Chat card
 * widget has no native progress bar, so we encode the state in text +
 * symbols the operator can read at a glance:
 *
 *   `🟢 Hoje 12% + 5% / 40%  ·  🟡 7d 27% + 5% / 30%`
 *
 * Symbol coding (per cap independently):
 *   🟢  consumed + proposed ≤ 70 % of cap        — safe
 *   🟡  70 % < total ≤ 100 % of cap              — careful
 *   🔴  total > cap                              — would breach
 */
function formatCapsConsumption(d: {
  todayPct: number
  sevenDayPct: number
  dailyCapPct: number
  sevenDayCapPct: number
  proposedDeltaPct: number
}): string {
  const dailyTotal = d.todayPct + d.proposedDeltaPct
  const sevenTotal = d.sevenDayPct + d.proposedDeltaPct
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`
  return (
    `${capDot(dailyTotal, d.dailyCapPct)} Hoje ${pct(d.todayPct)} + ${pct(d.proposedDeltaPct)} / ${pct(d.dailyCapPct)}` +
    `  ·  ` +
    `${capDot(sevenTotal, d.sevenDayCapPct)} 7d ${pct(d.sevenDayPct)} + ${pct(d.proposedDeltaPct)} / ${pct(d.sevenDayCapPct)}`
  )
}

function capDot(total: number, cap: number): string {
  if (total > cap) return '🔴'
  if (total > cap * 0.7) return '🟡'
  return '🟢'
}

/**
 * Build a Google Chat card v2 payload for a recommendation. The Approve /
 * Reject buttons use `openLink` rather than `action.function` because the
 * card is posted via the space's incoming webhook URL — Google Chat doesn't
 * know which Chat App owns the message, so it has no app to dispatch button
 * callbacks to. Instead, each button opens a new tab on our SPA at
 * `<appOrigin>/recommendations/<id>?action=approve|reject`; the SPA reads
 * the query string, POSTs to /api/recommendations/:id/(approve|reject) using
 * the user's existing Google OAuth session, then closes the tab.
 *
 * @param i         The card content.
 * @param appOrigin Origin of the SPA (e.g. https://gotrends-agent.devgogroup.com).
 *                  Must be a fully-qualified scheme://host (no trailing slash).
 */
export function buildRecommendationCard(i: RecommendationCardInput, appOrigin: string) {
  const blocked = i.guardrailStatus === 'blocked'
  const trimmedOrigin = appOrigin.replace(/\/+$/, '')
  return {
    cardsV2: [{
      cardId: i.recommendationId,
      card: {
        header: { title: i.headline, subtitle: i.campaign },
        sections: [{
          widgets: [
            { decoratedText: { topLabel: 'Mudança proposta', text: fmtPct(i.changePercent) } },
            { decoratedText: { topLabel: 'Receita incremental esperada', text: fmtBrl(i.expectedRevenueBrl) } },
            { decoratedText: { topLabel: 'Custo incremental esperado', text: fmtBrl(i.expectedCostBrl) } },
            { decoratedText: { topLabel: 'ROAS marginal', text: i.marginalRoas !== null ? i.marginalRoas.toFixed(2).replace('.', ',') : '—' } },
            { decoratedText: { topLabel: 'Confiança', text: i.confidence !== null ? String(i.confidence) : '—' } },
            { decoratedText: { topLabel: 'Risco', text: i.risk ? (RISK_LABELS[i.risk] ?? i.risk) : '—' } },
            { decoratedText: { topLabel: 'Guardrail', text: GUARDRAIL_LABELS[i.guardrailStatus] ?? i.guardrailStatus } },
            // tROAS caps consumption — only rendered when a drift snapshot
            // was supplied (caller signalling: this is a tROAS action AND
            // we successfully looked the drift up). Empty array spread =
            // widget disappears entirely for budget actions / missing data.
            ...(i.troasDrift ? [{
              decoratedText: {
                topLabel: 'Consumo dos caps (tROAS)',
                text: formatCapsConsumption(i.troasDrift),
              },
            }] : []),
            ...(blocked ? [] : [{
              buttonList: {
                buttons: [
                  {
                    text: 'Aprovar',
                    onClick: {
                      openLink: {
                        url: `${trimmedOrigin}/recommendations/${i.recommendationId}?action=approve`,
                        openAs: 'OVERLAY',
                        onClose: 'RELOAD',
                      },
                    },
                    color: { red: 0.1, green: 0.6, blue: 0.2 },
                  },
                  {
                    text: 'Rejeitar',
                    onClick: {
                      openLink: {
                        url: `${trimmedOrigin}/recommendations/${i.recommendationId}?action=reject`,
                        openAs: 'OVERLAY',
                        onClose: 'RELOAD',
                      },
                    },
                    color: { red: 0.7, green: 0.1, blue: 0.1 },
                  },
                ],
              },
            }]),
          ],
        }],
      },
    }],
  }
}

// ---- Outbound client ----

export class GoogleChatClient {
  private readonly fetcher: Fetcher
  constructor(fetcher?: Fetcher) {
    // Wrap global fetch in an arrow so the call site never sets `this` to the
    // class instance. Cloudflare Workers' fetch enforces `this === globalThis`
    // and throws `Illegal invocation` otherwise.
    this.fetcher = fetcher ?? ((...args) => fetch(...args))
  }

  async postCard(webhookUrl: string, body: ReturnType<typeof buildRecommendationCard>): Promise<{ name: string }> {
    const res = await this.fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`googleChat ${res.status}: ${(await res.text()).slice(0, 500)}`)
    return await res.json() as { name: string }
  }
}

// ---- Inbound webhook parser ----

/** Action user clicked: approve or reject. */
export type InteractionAction = 'approve' | 'reject'

export interface InteractionEvent {
  recommendationId: string
  action: InteractionAction
  user: {
    email: string | null
    displayName: string | null
    chatUserId: string | null
  }
  messageName: string | null  // e.g., "spaces/AAAA/messages/BBBB"
  spaceId: string | null
}

/** Parse an inbound Google Chat interactive event (button click).
 *  Throws Error if payload shape doesn't match what we sent in buildRecommendationCard.
 */
export function parseInteractionEvent(raw: unknown): InteractionEvent {
  const p = raw as {
    common?: { invokedFunction?: string; parameters?: Record<string, string> }
    action?: { actionMethodName?: string; parameters?: Array<{ key: string; value: string }> }
    user?: { email?: string; displayName?: string; name?: string }
    message?: { name?: string; space?: { name?: string } }
    space?: { name?: string }
  }

  // action function name lives in either common.invokedFunction or action.actionMethodName
  const fn = p.common?.invokedFunction ?? p.action?.actionMethodName ?? null
  if (fn !== 'approve' && fn !== 'reject') {
    throw new Error(`unknown action function: ${fn}`)
  }

  // parameters: structured form (action.parameters: [{key, value}]) OR common.parameters (record)
  let recommendationId: string | null = null
  if (Array.isArray(p.action?.parameters)) {
    recommendationId = p.action.parameters.find(x => x.key === 'rec')?.value ?? null
  }
  if (recommendationId === null && p.common?.parameters) {
    recommendationId = p.common.parameters['rec'] ?? null
  }
  if (recommendationId === null) {
    throw new Error('missing rec parameter')
  }

  const user = {
    email: p.user?.email ?? null,
    displayName: p.user?.displayName ?? null,
    chatUserId: p.user?.name ?? null,  // "users/123..."
  }

  const messageName = p.message?.name ?? null
  const spaceId = p.message?.space?.name ?? p.space?.name ?? null

  return { recommendationId, action: fn as InteractionAction, user, messageName, spaceId }
}
