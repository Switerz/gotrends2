// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { SWRConfig } from 'swr'
import Skills from '~/pages/Skills'
import { AppShell } from '~/components/layout/AppShell'

const SKILLS = [
  {
    key: 'budget_efficiency',
    displayName: 'Eficiência de orçamento',
    category: 'optimization',
    description: 'Ajusta budget baseado em ROAS marginal.',
  },
  {
    key: 'anomaly_scan',
    displayName: 'Varredura de anomalias',
    category: 'diagnostic',
    description: 'Detecta quedas e picos atípicos.',
  },
  {
    key: 'weekly_digest',
    displayName: 'Digest semanal',
    category: 'reporting',
    description: 'Resumo executivo das ações da semana.',
  },
]

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => SKILLS,
    }),
  )
})

describe('Skills page', () => {
  it('renders skill catalog grouped by category', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/skills']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="skills" element={<Skills />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText('Eficiência de orçamento')).toBeInTheDocument()
    })
    expect(screen.getByText('Varredura de anomalias')).toBeInTheDocument()
    expect(screen.getByText('Digest semanal')).toBeInTheDocument()
  })
})
