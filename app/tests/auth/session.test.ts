// tests/auth/session.test.ts
//
// Round-trip + tamper tests for the HMAC-signed session cookie.

import { describe, it, expect } from 'vitest'
import {
  encodeSession,
  decodeSession,
  buildSetCookieHeader,
  buildClearCookieHeader,
  readCookie,
  readNamedCookie,
} from '@/auth/session'

const SECRET = 'test-secret-32+chars-of-noise-xxxx'

describe('session cookie', () => {
  it('round-trips a payload', async () => {
    const exp = Date.now() + 60_000
    const cookie = await encodeSession({ email: 'a@b.com', expMs: exp }, SECRET)
    const decoded = await decodeSession(cookie, SECRET, Date.now())
    expect(decoded).toEqual({ email: 'a@b.com', expMs: exp })
  })

  it('rejects a tampered body', async () => {
    const cookie = await encodeSession({ email: 'a@b.com', expMs: Date.now() + 60_000 }, SECRET)
    const [body, sig] = cookie.split('.') as [string, string]
    // mutate the body but keep the signature → mismatch
    const tampered = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A') + '.' + sig
    const decoded = await decodeSession(tampered, SECRET, Date.now())
    expect(decoded).toBeNull()
  })

  it('rejects a wrong signature', async () => {
    const cookie = await encodeSession({ email: 'a@b.com', expMs: Date.now() + 60_000 }, SECRET)
    const [body] = cookie.split('.') as [string, string]
    const wrong = body + '.AAAAAAAAAAAAAAAAAAAA'
    const decoded = await decodeSession(wrong, SECRET, Date.now())
    expect(decoded).toBeNull()
  })

  it('rejects when signed with a different secret', async () => {
    const cookie = await encodeSession({ email: 'a@b.com', expMs: Date.now() + 60_000 }, SECRET)
    const decoded = await decodeSession(cookie, 'other-secret', Date.now())
    expect(decoded).toBeNull()
  })

  it('rejects expired payloads', async () => {
    const cookie = await encodeSession({ email: 'a@b.com', expMs: Date.now() - 1 }, SECRET)
    const decoded = await decodeSession(cookie, SECRET, Date.now())
    expect(decoded).toBeNull()
  })

  it('rejects malformed cookies (wrong number of parts)', async () => {
    expect(await decodeSession('not-a-cookie', SECRET, Date.now())).toBeNull()
    expect(await decodeSession('only.two.parts.here', SECRET, Date.now())).toBeNull()
  })

  it('rejects payloads with wrong shape', async () => {
    // Build a valid-signature cookie around a payload missing required fields.
    const body = btoa(JSON.stringify({ nope: true }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    // Sign it
    const k = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)),
    )
    let bin = ''
    for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]!)
    const sigB64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const decoded = await decodeSession(`${body}.${sigB64}`, SECRET, Date.now())
    expect(decoded).toBeNull()
  })

  it('builds Set-Cookie headers with HttpOnly + Secure + SameSite=Lax', () => {
    const h = buildSetCookieHeader('abc.def')
    expect(h).toMatch(/gotrends_session=abc\.def/)
    expect(h).toMatch(/HttpOnly/)
    expect(h).toMatch(/Secure/)
    expect(h).toMatch(/SameSite=Lax/)
    expect(h).toMatch(/Max-Age=\d+/)
  })

  it('builds a clear-cookie header with Max-Age=0', () => {
    const h = buildClearCookieHeader()
    expect(h).toMatch(/Max-Age=0/)
    expect(h).toMatch(/gotrends_session=;/)
  })

  it('readCookie extracts the session cookie from a multi-cookie header', () => {
    const got = readCookie('foo=bar; gotrends_session=abc.def; baz=qux')
    expect(got).toBe('abc.def')
  })

  it('readCookie returns null when the session cookie is absent', () => {
    expect(readCookie('foo=bar; baz=qux')).toBeNull()
    expect(readCookie(undefined)).toBeNull()
    expect(readCookie('')).toBeNull()
  })

  it('readNamedCookie pulls arbitrary names', () => {
    expect(readNamedCookie('foo=bar; gotrends_oauth_state=xyz; baz=qux', 'gotrends_oauth_state')).toBe(
      'xyz',
    )
    expect(readNamedCookie('foo=bar', 'gotrends_oauth_state')).toBeNull()
  })
})
