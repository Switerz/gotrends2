// tests/auth/_helpers.ts
//
// Shared helpers for tests that need a logged-in session cookie. Uses the same
// encoder the worker uses, so the production decoder verifies the signature
// for real (no mocks of the auth layer itself).

import { encodeSession } from '@/auth/session'

export const TEST_SESSION_SECRET = 'test-session-secret-32+chars-of-noise-xxxx'

/** Encode a fresh session cookie usable as a `Cookie: gotrends_session=...` header value. */
export async function makeSessionCookie(
  email = 'pedro@gobeaute.com.br',
  ttlMs = 60 * 60 * 1000,
): Promise<string> {
  const value = await encodeSession({ email, expMs: Date.now() + ttlMs }, TEST_SESSION_SECRET)
  return `gotrends_session=${value}`
}

/** Encode a session cookie that already expired. */
export async function makeExpiredSessionCookie(email = 'pedro@gobeaute.com.br'): Promise<string> {
  const value = await encodeSession({ email, expMs: Date.now() - 1000 }, TEST_SESSION_SECRET)
  return `gotrends_session=${value}`
}
