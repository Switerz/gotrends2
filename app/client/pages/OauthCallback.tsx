// Standalone OAuth callback page (no AppShell / sidebar).
//
// Google redirects the browser to /api/auth/callback?code=...&state=... after
// consent. Because the Godeploy asset handler intercepts Accept: text/html for
// /api/* and serves the SPA shell, this React component renders. It then
// fetches /api/auth/callback with Accept: application/json — that request
// reaches the worker, which validates state, exchanges the code, sets the
// session cookie, and returns { ok: true, email }. We then navigate to the
// post-login path (stashed in sessionStorage before redirect) or to /.

import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'

export default function OauthCallback() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState<'pending' | 'error'>('pending')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state) {
      setStatus('error')
      setError('missing code/state in URL')
      return
    }

    void (async () => {
      try {
        const res = await fetch(
          `/api/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          {
            headers: { accept: 'application/json' },
            credentials: 'include',
          },
        )
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`callback failed ${res.status}: ${body.slice(0, 200)}`)
        }
        const nextPath = sessionStorage.getItem('gotrends_post_login_path') ?? '/'
        sessionStorage.removeItem('gotrends_post_login_path')
        navigate(nextPath, { replace: true })
      } catch (e) {
        setStatus('error')
        setError((e as Error).message)
      }
    })()
  }, [params, navigate])

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-900 text-ink-100 px-6">
        <div className="rounded-card bg-ink-800 shadow-inset-hairline p-8 max-w-md">
          <div className="font-display text-2xl mb-2">Falha no login</div>
          <p className="text-sm text-ink-300 mb-4">{error ?? 'erro desconhecido'}</p>
          <a
            href="/"
            className="text-sage hover:underline underline-offset-4 decoration-sage/40"
          >
            Voltar para o início
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink-900 text-ink-100">
      <div className="text-center">
        <div className="font-display text-2xl mb-2">Entrando…</div>
        <p className="text-sm text-ink-300">Validando sua sessão Google.</p>
      </div>
    </div>
  )
}
