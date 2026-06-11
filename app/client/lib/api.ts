// Thin JSON fetch wrapper used by the SWR hooks. Throws on non-2xx so SWR
// surfaces the error through `error`. The fetcher is generic over the
// response shape so SWR's type inference works without explicit annotations.
//
// On 401 we cannot just navigate to /api/auth/login: Godeploy's asset handler
// intercepts Accept: text/html for /api/* and serves the SPA shell instead of
// the worker. Instead we fetch /api/auth/login with Accept: application/json
// (worker responds JSON with { url, state } and sets the state cookie), then
// navigate the window to the returned Google authorize URL.
//
// All requests send credentials: 'include' so cookies are sent.

async function startOauthLogin(currentPath: string): Promise<void> {
  try {
    const res = await fetch('/api/auth/login', {
      headers: { accept: 'application/json' },
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`login init ${res.status}`)
    const data = (await res.json()) as { url: string }
    if (currentPath && currentPath !== '/') {
      sessionStorage.setItem('gotrends_post_login_path', currentPath)
    }
    window.location.href = data.url
  } catch {
    // Fall back to direct navigation (best-effort — will hit the asset handler,
    // but the SPA boot will retry the JSON fetch).
    window.location.href = `/api/auth/login?next=${encodeURIComponent(currentPath)}`
  }
}

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { accept: 'application/json' },
    credentials: 'include',
  })
  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      void startOauthLogin(window.location.pathname + window.location.search)
    }
    throw new Error('redirecting to login')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

export const fetcher = <T>(url: string): Promise<T> => api<T>(url)
