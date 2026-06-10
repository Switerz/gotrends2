// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import Runs from '~/pages/Runs'
import { AppShell } from '~/components/layout/AppShell'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'run-abc123ef',
          accountId: '7705857660',
          runTs: new Date().toISOString(),
          pipelineVersion: 'v2.0.0',
          status: 'success',
          nCampaignsScanned: 12,
          nRecommendations: 3,
          inputWindow: { start: '2026-06-01', end: '2026-06-07' },
          notes: null,
        },
      ],
    }),
  )
})

describe('Runs page', () => {
  it('renders heading and a row from the API', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/runs']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="runs" element={<Runs />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText('run-abc1')).toBeInTheDocument()
    })
  })
})
