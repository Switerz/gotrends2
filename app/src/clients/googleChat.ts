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

export function buildRecommendationCard(i: RecommendationCardInput) {
  const blocked = i.guardrailStatus === 'blocked'
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
            { decoratedText: { topLabel: 'Risco', text: i.risk ?? '—' } },
            { decoratedText: { topLabel: 'Guardrail', text: i.guardrailStatus } },
            ...(blocked ? [] : [{
              buttonList: {
                buttons: [
                  {
                    text: 'Aprovar',
                    onClick: { action: { function: 'approve', parameters: [{ key: 'rec', value: i.recommendationId }] } },
                    color: { red: 0.1, green: 0.6, blue: 0.2 },
                  },
                  {
                    text: 'Rejeitar',
                    onClick: { action: { function: 'reject', parameters: [{ key: 'rec', value: i.recommendationId }] } },
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
  constructor(private fetcher: Fetcher = fetch) {}

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
