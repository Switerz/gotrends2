// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SWRConfig } from 'swr'
import { App } from '~/App'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
  )
})

describe('App router', () => {
  it('routes / to Dashboard', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    })
  })

  it('routes /skills to Skills page', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/skills']}>
          <App />
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    })
  })

  it('routes unknown path to 404', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/no-such-route']}>
          <App />
        </MemoryRouter>
      </SWRConfig>,
    )
    await waitFor(() => {
      expect(screen.getByText('404')).toBeInTheDocument()
    })
  })
})
