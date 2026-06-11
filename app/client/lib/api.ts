// Thin JSON fetch wrapper used by the SWR hooks. Throws on non-2xx so SWR
// surfaces the error through `error`. The fetcher is generic over the
// response shape so SWR's type inference works without explicit annotations.
//
// On 401 the wrapper bounces the browser to /api/auth/login with a ?next= hint
// so the OAuth callback can deep-link back after sign-in. The /api/ prefix is
// required because the Godeploy asset handler catches bare /auth/* paths and
// serves the SPA shell instead of routing to the worker.

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      window.location.href = `/api/auth/login?next=${encodeURIComponent(
        window.location.pathname + window.location.search,
      )}`
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
