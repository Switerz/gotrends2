// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import Dashboard from '~/pages/Dashboard'
import { AppShell } from '~/components/layout/AppShell'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }),
  )
})

describe('Dashboard page', () => {
  it('renders heading with empty data', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Dashboard />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    })
    expect(screen.getByText('Visão geral das recomendações ativas.')).toBeInTheDocument()
  })

  it('shows non-zero counts when recommendations are present', async () => {
    const recs = [
      { id: 'a', runId: 'r1', account: { id: 'x', label: null }, campaign: { id: 'c1', name: 'Camp 1' }, skill: 'skill_a', action: 'monitor', changePercent: 0.1, current: { budgetBrl: null, targetRoas: null }, proposed: { budgetBrl: null, targetRoas: null }, expected: { incrementalCostBrl: null, incrementalRevenueBrl: null, marginalRoas: null, projectedCos: null }, confidence: 0.7, risk: 'low', guardrail: { status: 'ok', reason: null }, reason: null, llmExplanation: null, status: 'pending', expiresAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => (url.includes('/recommendations') ? recs : []),
      })),
    )
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Dashboard />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByText('Camp 1')).toBeInTheDocument()
    })
  })
})
