// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import RunDetail from '~/pages/RunDetail'
import { AppShell } from '~/components/layout/AppShell'

const RUN = {
  id: 'run-abc123ef',
  accountId: '7705857660',
  runTs: new Date().toISOString(),
  pipelineVersion: 'v2.0.0',
  status: 'success',
  nCampaignsScanned: 12,
  nRecommendations: 3,
  inputWindow: { start: '2026-06-01', end: '2026-06-07' },
  notes: 'Run de teste',
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes('/api/runs/') ? RUN : []),
    })),
  )
})

describe('RunDetail page', () => {
  it('renders run header from API', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/runs/run-abc123ef']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="runs/:id" element={<RunDetail />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByText('run-abc1')).toBeInTheDocument()
    })
    expect(screen.getByText('Configuração')).toBeInTheDocument()
    expect(screen.getByText('Resultados')).toBeInTheDocument()
  })
})
