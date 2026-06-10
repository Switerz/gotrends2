// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import RecommendationDetail from '~/pages/RecommendationDetail'
import { AppShell } from '~/components/layout/AppShell'

const REC = {
  id: 'rec-abc',
  runId: 'run-1',
  account: { id: '7705857660', label: 'Apice' },
  campaign: { id: 'camp-9', name: 'Coleção Verão' },
  skill: 'budget_efficiency',
  action: 'increase_budget',
  changePercent: 0.15,
  current: { budgetBrl: 1000, targetRoas: 3.0 },
  proposed: { budgetBrl: 1150, targetRoas: 3.0 },
  expected: {
    incrementalCostBrl: 150,
    incrementalRevenueBrl: 600,
    marginalRoas: 4.0,
    projectedCos: 0.25,
  },
  confidence: 0.78,
  risk: 'low',
  guardrail: { status: 'ok', reason: null },
  reason: 'ROAS marginal acima do alvo.',
  llmExplanation: 'Aumentar o orçamento mantém ROAS saudável.',
  status: 'pending',
  expiresAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => REC,
    }),
  )
})

describe('RecommendationDetail page', () => {
  it('renders campaign name from API', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/recommendations/rec-abc']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="recommendations/:id" element={<RecommendationDetail />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Coleção Verão' })).toBeInTheDocument()
    })
    expect(screen.getByText('Aumentar o orçamento mantém ROAS saudável.')).toBeInTheDocument()
  })
})
