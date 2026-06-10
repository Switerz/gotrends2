// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import Digest from '~/pages/Digest'
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

describe('Digest page', () => {
  it('renders heading and section titles', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/digest']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="digest" element={<Digest />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Digest Semanal' })).toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: 'Esta semana' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Destaques' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bloqueadas' })).toBeInTheDocument()
  })
})
