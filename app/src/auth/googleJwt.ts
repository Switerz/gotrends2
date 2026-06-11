// src/auth/googleJwt.ts
//
// RS256 JWT verification for Google Chat's signed webhook requests. Chat signs
// the bearer token with `chat@system.gserviceaccount.com`; we fetch the
// matching JWK from Google's public JWKS endpoint and verify via WebCrypto.
//
// The JWKS document is cached at module scope for an hour to avoid one HTTP
// hop per webhook delivery. The cache is invalidated on TTL only — Google
// rotates keys but always serves both old and new keys while in flight.

interface Jwk {
  kid: string
  kty: 'RSA'
  alg: 'RS256'
  use: 'sig'
  n: string
  e: string
}

interface JwkSet {
  keys: Jwk[]
}

export const CHAT_ISSUER = 'chat@system.gserviceaccount.com'
export const CHAT_JWKS_URL = `https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`

const JWKS_TTL_MS = 60 * 60 * 1000 // 1h

let cachedJwks: JwkSet | null = null
let cachedAt = 0

/** TESTING ONLY: reset the JWKS cache between tests. */
export function _resetJwksCacheForTests(): void {
  cachedJwks = null
  cachedAt = 0
}

async function fetchJwks(nowMs: number): Promise<JwkSet> {
  if (cachedJwks && nowMs - cachedAt < JWKS_TTL_MS) return cachedJwks
  const res = await fetch(CHAT_JWKS_URL)
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`)
  cachedJwks = (await res.json()) as JwkSet
  cachedAt = nowMs
  return cachedJwks
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

export interface VerifiedJwtPayload {
  iss: string
  aud: string
  exp: number
  iat: number
  [k: string]: unknown
}

export async function verifyChatJwt(
  jwt: string,
  audience: string,
  nowMs: number = Date.now(),
): Promise<VerifiedJwtPayload> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('jwt: malformed')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  let header: { kid?: string; alg?: string }
  let payload: VerifiedJwtPayload
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64))) as {
      kid?: string
      alg?: string
    }
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as VerifiedJwtPayload
  } catch {
    throw new Error('jwt: malformed')
  }
  if (header.alg !== 'RS256') throw new Error(`jwt: unexpected alg ${header.alg}`)
  if (!header.kid) throw new Error('jwt: missing kid')

  // Validate claims first; cheaper than a JWKS round-trip on a bogus token.
  if (payload.iss !== CHAT_ISSUER) throw new Error(`jwt: unexpected issuer ${payload.iss}`)
  if (payload.aud !== audience) throw new Error(`jwt: unexpected audience ${payload.aud}`)
  const nowSec = Math.floor(nowMs / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) throw new Error('jwt: expired')

  const jwks = await fetchJwks(nowMs)
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error(`jwt: unknown kid ${header.kid}`)

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, use: jwk.use, ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const signature = b64urlToBytes(sigB64)
  // Cast through ArrayBufferView<ArrayBuffer> — workers-types narrows BufferSource
  // to non-shared buffers; our Uint8Arrays are always backed by ArrayBuffer.
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature as unknown as BufferSource,
    data as unknown as BufferSource,
  )
  if (!valid) throw new Error('jwt: signature mismatch')
  return payload
}
