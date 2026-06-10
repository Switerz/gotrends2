// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import Recommendations from '~/pages/Recommendations'
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

describe('Recommendations page', () => {
  it('renders heading and filter controls', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/recommendations']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="recommendations" element={<Recommendations />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Recomendações' })).toBeInTheDocument()
    })
    expect(screen.getByPlaceholderText('Buscar campanha…')).toBeInTheDocument()
    expect(screen.getByText('Limpar')).toBeInTheDocument()
  })
})
