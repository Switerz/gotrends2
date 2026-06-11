import { describe, expect, it, vi } from 'vitest'
import {
  GoogleChatClient,
  buildRecommendationCard,
  parseInteractionEvent,
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

// Type helpers to inspect builder output without strict shape coupling.
interface Widget {
  decoratedText?: { topLabel?: string; text?: string }
  buttonList?: {
    buttons: Array<{
      text: string
      onClick: { action: { function: string; parameters: Array<{ key: string; value: string }> } }
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

describe('buildRecommendationCard', () => {
  it('builds a basic happy card with header, ≥7 decoratedText widgets, and 1 buttonList with 2 buttons', () => {
    const card = buildRecommendationCard(baseInput())
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
    const card = buildRecommendationCard(baseInput({ guardrailStatus: 'blocked' }))
    const buttonLists = widgetsOf(card).filter(w => w.buttonList)
    expect(buttonLists).toHaveLength(0)
  })

  it('shows buttons when guardrailStatus=ok or needs_human_review', () => {
    const ok = buildRecommendationCard(baseInput({ guardrailStatus: 'ok' }))
    const review = buildRecommendationCard(baseInput({ guardrailStatus: 'needs_human_review' }))
    expect(findButtonList(ok)).toBeDefined()
    expect(findButtonList(review)).toBeDefined()
    expect(findButtonList(ok)!.buttons).toHaveLength(2)
    expect(findButtonList(review)!.buttons).toHaveLength(2)
  })

  it('button onClick parameters carry the recommendation id under key "rec" for both Approve and Reject', () => {
    const card = buildRecommendationCard(baseInput({ recommendationId: 'rec-xyz' }))
    const btns = findButtonList(card)!.buttons
    const approve = btns.find(b => b.onClick.action.function === 'approve')!
    const reject = btns.find(b => b.onClick.action.function === 'reject')!
    expect(approve.text).toBe('Aprovar')
    expect(approve.onClick.action.parameters).toEqual([{ key: 'rec', value: 'rec-xyz' }])
    expect(reject.text).toBe('Rejeitar')
    expect(reject.onClick.action.parameters).toEqual([{ key: 'rec', value: 'rec-xyz' }])
  })

  it('formats BRL: 1234.56 → "R$ 1.234,56", -42.50 → "-R$ 42,50", null → "—"', () => {
    const card1 = buildRecommendationCard(baseInput({ expectedRevenueBrl: 1234.56 }))
    expect(textOf(card1, 'Receita incremental esperada')).toBe('R$ 1.234,56')

    const card2 = buildRecommendationCard(baseInput({ expectedRevenueBrl: -42.5 }))
    expect(textOf(card2, 'Receita incremental esperada')).toBe('-R$ 42,50')

    const card3 = buildRecommendationCard(baseInput({ expectedRevenueBrl: null }))
    expect(textOf(card3, 'Receita incremental esperada')).toBe('—')
  })

  it('formats percentages: 0.123 → "12,3%", -0.05 → "-5,0%", null → "—"', () => {
    const card1 = buildRecommendationCard(baseInput({ changePercent: 0.123 }))
    expect(textOf(card1, 'Mudança proposta')).toBe('12,3%')

    const card2 = buildRecommendationCard(baseInput({ changePercent: -0.05 }))
    expect(textOf(card2, 'Mudança proposta')).toBe('-5,0%')

    const card3 = buildRecommendationCard(baseInput({ changePercent: null }))
    expect(textOf(card3, 'Mudança proposta')).toBe('—')
  })

  it('renders null numeric/text fields as em-dash and never produces empty widget texts', () => {
    const card = buildRecommendationCard(baseInput({
      changePercent: null,
      expectedRevenueBrl: null,
      expectedCostBrl: null,
      marginalRoas: null,
      confidence: null,
      risk: null,
    }))
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
    const card = buildRecommendationCard(baseInput({ marginalRoas: 2.987 }))
    expect(textOf(card, 'ROAS marginal')).toBe('2,99')
  })
})

describe('GoogleChatClient.postCard', () => {
  it('sends a POST to the webhookUrl with content-type and JSON-stringified body', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ name: 'spaces/X/messages/Y' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = new GoogleChatClient(fetcher)
    const card = buildRecommendationCard(baseInput())
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
    await expect(client.postCard('https://example.invalid', buildRecommendationCard(baseInput())))
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
