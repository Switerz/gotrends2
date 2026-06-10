// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import Campaign from '~/pages/Campaign'
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

describe('Campaign page', () => {
  it('renders campaign id from URL with empty history', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/campaigns/7705857660/camp-9']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="campaigns/:accountId/:campaignId"
                element={<Campaign />}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByText('Histórico de recomendações')).toBeInTheDocument()
    })
    // 'camp-9' shows up in both the breadcrumb and the page header — use getAllByText.
    expect(screen.getAllByText('camp-9').length).toBeGreaterThan(0)
    expect(screen.getByText('Sem recomendações')).toBeInTheDocument()
  })
})
