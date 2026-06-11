// src/auth/session.ts
//
// HMAC-signed session cookie. The cookie body carries a small JSON payload
// (`email`, `expMs`); the signature is HMAC-SHA-256 keyed by `SESSION_SECRET`.
// Both halves are base64url so the cookie value is URL-safe and survives
// round-trip through `document.cookie` and the `Cookie:` header.
//
// `decodeSession` is constant-time on the signature comparison and rejects
// expired payloads, so a stolen cookie has a hard 12-hour ceiling.

/** Session payload encoded in the cookie. */
export interface SessionPayload {
  email: string
  /** Epoch ms when the session expires. */
  expMs: number
}

const COOKIE_NAME = 'gotrends_session'
const COOKIE_MAX_AGE = 60 * 60 * 12 // 12 hours

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return base64url(new Uint8Array(sig))
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  const s = btoa(bin)
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

export async function encodeSession(p: SessionPayload, secret: string): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(p)))
  const sig = await hmacSign(body, secret)
  return `${body}.${sig}`
}

export async function decodeSession(
  cookie: string,
  secret: string,
  nowMs: number,
): Promise<SessionPayload | null> {
  const parts = cookie.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts as [string, string]
  const expected = await hmacSign(body, secret)
  if (!constantTimeEqual(sig, expected)) return null
  try {
    const json = new TextDecoder().decode(base64urlDecode(body))
    const p = JSON.parse(json) as SessionPayload
    if (typeof p.email !== 'string' || typeof p.expMs !== 'number') return null
    if (nowMs > p.expMs) return null
    return p
  } catch {
    return null
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function buildSetCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
}

export function buildClearCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/** Pull the session cookie value out of a raw Cookie header, if present. */
export function readCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const k = trimmed.slice(0, eq)
    if (k === COOKIE_NAME) return trimmed.slice(eq + 1)
  }
  return null
}

/** Pull an arbitrary named cookie out of a raw Cookie header (used for oauth state). */
export function readNamedCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const k = trimmed.slice(0, eq)
    if (k === name) return trimmed.slice(eq + 1)
  }
  return null
}

export const SESSION_COOKIE_NAME = COOKIE_NAME
export const SESSION_MAX_AGE_SECONDS = COOKIE_MAX_AGE
