import { describe, expect, it, vi } from 'vitest'
import {
  GoogleChatClient,
  buildRecommendationCard,
  parseInteractionEvent,
  ACTION_LABELS_CARD,
  type RecommendationCardInput,
} from '@/clients/googleChat'

function baseInput(overrides: Partial<RecommendationCardInput> = {}): RecommendationCardInput {
  return {
    recommendationId: 'rec-123',
    headline: 'Reduce spend by 20%',
    campaign: 'Search - Brand',
    changePercent: -0.2,
    expectedRevenueBrl: 1234.56,
    expectedCostBrl: 567.89,
    marginalRoas: 2.45,
    confidence: 0.82,
    risk: 'low',
    guardrailStatus: 'ok',
    ...overrides,
  }
}

const TEST_ORIGIN = 'https://gotrends-agent.devgogroup.com'

// Type helpers to inspect builder output without strict shape coupling.
interface Widget {
  decoratedText?: { topLabel?: string; text?: string }
  buttonList?: {
    buttons: Array<{
      text: string
      onClick: { openLink: { url: string } }
      color: { red: number; green: number; blue: number }
    }>
  }
}

function widgetsOf(card: ReturnType<typeof buildRecommendationCard>): Widget[] {
  return card.cardsV2[0]!.card.sections[0]!.widgets as Widget[]
}

function findButtonList(card: ReturnType<typeof buildRecommendationCard>) {
  return widgetsOf(card).find(w => w.buttonList)?.buttonList
}

function textOf(card: ReturnType<typeof buildRecommendationCard>, label: string): string | undefined {
  const w = widgetsOf(card).find(x => x.decoratedText?.topLabel === label)
  return w?.decoratedText?.text
}

function build(overrides: Partial<RecommendationCardInput> = {}, origin = TEST_ORIGIN) {
  return buildRecommendationCard(baseInput(overrides), origin)
}

describe('buildRecommendationCard', () => {
  it('builds a basic happy card with header, ≥7 decoratedText widgets, and 1 buttonList with 2 buttons', () => {
    const card = build()
    const top = card.cardsV2[0]!
    expect(top.cardId).toBe('rec-123')
    expect(top.card.header.title).toBe('Reduce spend by 20%')
    expect(top.card.header.subtitle).toBe('Search - Brand')

    const widgets = widgetsOf(card)
    const decoratedCount = widgets.filter(w => w.decoratedText).length
    expect(decoratedCount).toBeGreaterThanOrEqual(7)

    const buttonLists = widgets.filter(w => w.buttonList)
    expect(buttonLists).toHaveLength(1)
    expect(buttonLists[0]!.buttonList!.buttons).toHaveLength(2)
  })

  it('hides buttons when guardrailStatus=blocked', () => {
    const card = build({ guardrailStatus: 'blocked' })
    const buttonLists = widgetsOf(card).filter(w => w.buttonList)
    expect(buttonLists).toHaveLength(0)
  })

  it('shows buttons when guardrailStatus=ok or needs_human_review', () => {
    const ok = build({ guardrailStatus: 'ok' })
    const review = build({ guardrailStatus: 'needs_human_review' })
    expect(findButtonList(ok)).toBeDefined()
    expect(findButtonList(review)).toBeDefined()
    expect(findButtonList(ok)!.buttons).toHaveLength(2)
    expect(findButtonList(review)!.buttons).toHaveLength(2)
  })

  it('Approve / Reject buttons use openLink URLs into the SPA carrying the recommendation id and ?action=', () => {
    const card = build({ recommendationId: 'rec-xyz' })
    const btns = findButtonList(card)!.buttons
    const approve = btns.find(b => b.text === 'Aprovar')!
    const reject = btns.find(b => b.text === 'Rejeitar')!
    expect(approve.onClick.openLink.url).toBe(
      `${TEST_ORIGIN}/recommendations/rec-xyz?action=approve`,
    )
    expect(reject.onClick.openLink.url).toBe(
      `${TEST_ORIGIN}/recommendations/rec-xyz?action=reject`,
    )
  })

  it('trims a trailing slash on appOrigin so URLs never get a double slash', () => {
    const card = buildRecommendationCard(
      baseInput({ recommendationId: 'rec-slash' }),
      `${TEST_ORIGIN}/`,
    )
    const btns = findButtonList(card)!.buttons
    expect(btns[0]!.onClick.openLink.url).toBe(
      `${TEST_ORIGIN}/recommendations/rec-slash?action=approve`,
    )
  })

  it('formats BRL: 1234.56 → "R$ 1.234,56", -42.50 → "-R$ 42,50", null → "—"', () => {
    const card1 = build({ expectedRevenueBrl: 1234.56 })
    expect(textOf(card1, 'Receita incremental esperada')).toBe('R$ 1.234,56')

    const card2 = build({ expectedRevenueBrl: -42.5 })
    expect(textOf(card2, 'Receita incremental esperada')).toBe('-R$ 42,50')

    const card3 = build({ expectedRevenueBrl: null })
    expect(textOf(card3, 'Receita incremental esperada')).toBe('—')
  })

  it('formats percentages: 0.123 → "12,3%", -0.05 → "-5,0%", null → "—"', () => {
    const card1 = build({ changePercent: 0.123 })
    expect(textOf(card1, 'Mudança proposta')).toBe('12,3%')

    const card2 = build({ changePercent: -0.05 })
    expect(textOf(card2, 'Mudança proposta')).toBe('-5,0%')

    const card3 = build({ changePercent: null })
    expect(textOf(card3, 'Mudança proposta')).toBe('—')
  })

  it('renders null numeric/text fields as em-dash and never produces empty widget texts', () => {
    const card = build({
      changePercent: null,
      expectedRevenueBrl: null,
      expectedCostBrl: null,
      marginalRoas: null,
      confidence: null,
      risk: null,
    })
    const decoratedTexts = widgetsOf(card)
      .filter(w => w.decoratedText)
      .map(w => w.decoratedText!.text)
    expect(decoratedTexts.length).toBeGreaterThanOrEqual(7)
    for (const t of decoratedTexts) {
      expect(t).toBeDefined()
      expect(typeof t).toBe('string')
      expect(t!.length).toBeGreaterThan(0)
    }
    // Specific labels should render as em-dash
    expect(textOf(card, 'Mudança proposta')).toBe('—')
    expect(textOf(card, 'Receita incremental esperada')).toBe('—')
    expect(textOf(card, 'Custo incremental esperado')).toBe('—')
    expect(textOf(card, 'ROAS marginal')).toBe('—')
    expect(textOf(card, 'Confiança')).toBe('—')
    expect(textOf(card, 'Risco')).toBe('—')
  })

  it('formats marginalRoas: 2.987 → "2,99" (2 decimals)', () => {
    const card = build({ marginalRoas: 2.987 })
    expect(textOf(card, 'ROAS marginal')).toBe('2,99')
  })

  it('humanises guardrailStatus on the Guardrail widget', () => {
    expect(textOf(build({ guardrailStatus: 'ok' }), 'Guardrail')).toBe('OK')
    expect(textOf(build({ guardrailStatus: 'needs_human_review' }), 'Guardrail')).toBe('Revisão humana')
    expect(textOf(build({ guardrailStatus: 'blocked' }), 'Guardrail')).toBe('Bloqueado')
  })

  it('humanises risk values to PT-BR (low/medium/high → baixo/médio/alto), passes through unknown values', () => {
    expect(textOf(build({ risk: 'low' }), 'Risco')).toBe('baixo')
    expect(textOf(build({ risk: 'medium' }), 'Risco')).toBe('médio')
    expect(textOf(build({ risk: 'high' }), 'Risco')).toBe('alto')
    // Unknown values must not be dropped — the card surfaces the raw string so
    // a new enum from the model is still visible until labels are extended.
    expect(textOf(build({ risk: 'unknown_tier' }), 'Risco')).toBe('unknown_tier')
  })

  it('exports a card-friendly action label map covering every action emitted by the agent', () => {
    // Sanity: each known action returns a non-empty, properly-cased PT-BR label
    expect(ACTION_LABELS_CARD['increase_troas_or_reduce_budget']).toBe('Aumentar tROAS ou reduzir budget')
    expect(ACTION_LABELS_CARD['increase_budget']).toBe('Aumentar budget')
    expect(ACTION_LABELS_CARD['monitor']).toBe('Monitorar')
    // Every entry starts with an uppercase letter — they're used as headlines.
    for (const label of Object.values(ACTION_LABELS_CARD)) {
      expect(label.length).toBeGreaterThan(0)
      expect(label[0]).toBe(label[0]!.toUpperCase())
    }
  })
})

describe('GoogleChatClient.postCard', () => {
  it('sends a POST to the webhookUrl with content-type and JSON-stringified body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ name: 'spaces/X/messages/Y' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = new GoogleChatClient(fetcher)
    const card = build()
    const result = await client.postCard('https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t', card)

    expect(result).toEqual({ name: 'spaces/X/messages/Y' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const call = fetcher.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call!
    expect(url).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t')
    expect(init).toBeDefined()
    const reqInit = init as RequestInit
    expect(reqInit.method).toBe('POST')
    const headers = reqInit.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(reqInit.body).toBe(JSON.stringify(card))
  })

  it('throws on non-2xx responses, including status code and snippet of body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('INVALID_ARGUMENT: bad cardsV2', { status: 400 }))
    const client = new GoogleChatClient(fetcher)
    await expect(client.postCard('https://example.invalid', build()))
      .rejects.toThrow(/googleChat 400/)
  })

  it('uses the global fetch when no fetcher is injected (smoke check on constructor default)', () => {
    // Just verifies construction with no args compiles and does not throw.
    const client = new GoogleChatClient()
    expect(client).toBeInstanceOf(GoogleChatClient)
  })
})

describe('parseInteractionEvent', () => {
  it('parses a happy approve event', () => {
    const evt = parseInteractionEvent({
      common: { invokedFunction: 'approve' },
      action: { parameters: [{ key: 'rec', value: 'rec-123' }] },
      user: { email: 'a@b.com', displayName: 'Alice', name: 'users/123' },
      message: { name: 'spaces/X/messages/Y', space: { name: 'spaces/X' } },
    })
    expect(evt).toEqual({
      recommendationId: 'rec-123',
      action: 'approve',
      user: { email: 'a@b.com', displayName: 'Alice', chatUserId: 'users/123' },
      messageName: 'spaces/X/messages/Y',
      spaceId: 'spaces/X',
    })
  })

  it('parses a happy reject event', () => {
    const evt = parseInteractionEvent({
      common: { invokedFunction: 'reject' },
      action: { parameters: [{ key: 'rec', value: 'rec-999' }] },
      user: { email: 'b@c.com', displayName: 'Bob', name: 'users/999' },
      message: { name: 'spaces/Z/messages/W', space: { name: 'spaces/Z' } },
    })
    expect(evt.action).toBe('reject')
    expect(evt.recommendationId).toBe('rec-999')
    expect(evt.user.email).toBe('b@c.com')
  })

  it('throws when function name is not approve/reject', () => {
    expect(() => parseInteractionEvent({
      common: { invokedFunction: 'foo' },
      action: { parameters: [{ key: 'rec', value: 'rec-1' }] },
    })).toThrow(/unknown action function/)
  })

  it('throws when "rec" parameter is missing', () => {
    expect(() => parseInteractionEvent({
      common: { invokedFunction: 'approve' },
      action: { parameters: [{ key: 'other', value: 'x' }] },
    })).toThrow(/missing rec parameter/)
  })

  it('falls back to common.parameters when action.parameters is absent', () => {
    const evt = parseInteractionEvent({
      common: { invokedFunction: 'approve', parameters: { rec: 'rec-fallback' } },
      user: { email: 'c@d.com' },
    })
    expect(evt.recommendationId).toBe('rec-fallback')
    expect(evt.action).toBe('approve')
    expect(evt.user.email).toBe('c@d.com')
    expect(evt.user.displayName).toBeNull()
    expect(evt.user.chatUserId).toBeNull()
    expect(evt.messageName).toBeNull()
    expect(evt.spaceId).toBeNull()
  })

  it('uses action.actionMethodName when common.invokedFunction is absent', () => {
    const evt = parseInteractionEvent({
      action: { actionMethodName: 'reject', parameters: [{ key: 'rec', value: 'rec-am' }] },
      user: { email: 'x@y.com', displayName: 'X', name: 'users/x' },
      space: { name: 'spaces/S' },
    })
    expect(evt.action).toBe('reject')
    expect(evt.recommendationId).toBe('rec-am')
    expect(evt.spaceId).toBe('spaces/S')
  })
})
