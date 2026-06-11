// tests/auth/googleJwt.test.ts
//
// Verifies the RS256 JWT verifier end-to-end. The approach: generate an
// RSASSA-PKCS1-v1_5 keypair in the test, export the public key as a JWK,
// stand up a mocked `fetch` that returns `{ keys: [<jwk>] }` for the JWKS
// endpoint, then sign a JWT with the private key and feed it through
// `verifyChatJwt`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  verifyChatJwt,
  CHAT_ISSUER,
  CHAT_JWKS_URL,
  _resetJwksCacheForTests,
} from '@/auth/googleJwt'

const AUDIENCE = 'https://gotrends-agent.devgogroup.com/chat/webhook'

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface TestKey {
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  kid: string
}

async function generateTestKey(kid = 'test-kid-1'): Promise<TestKey> {
  const kp = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { privateKey: kp.privateKey, publicJwk, kid }
}

async function signJwt(
  key: TestKey,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid }
  const headerB64 = b64url(JSON.stringify(header))
  const payloadB64 = b64url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  return `${signingInput}.${b64url(sig)}`
}

function mockJwksFetch(key: TestKey, opts: { calls?: { count: number } } = {}): void {
  const jwk = {
    kid: key.kid,
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    n: key.publicJwk.n,
    e: key.publicJwk.e,
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url === CHAT_JWKS_URL) {
      if (opts.calls) opts.calls.count++
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe('verifyChatJwt', () => {
  beforeEach(() => {
    _resetJwksCacheForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a valid RS256 JWT', async () => {
    const key = await generateTestKey()
    mockJwksFetch(key)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(key, {
      iss: CHAT_ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 60,
    })
    const out = await verifyChatJwt(jwt, AUDIENCE)
    expect(out.iss).toBe(CHAT_ISSUER)
    expect(out.aud).toBe(AUDIENCE)
  })

  it('rejects wrong issuer', async () => {
    const key = await generateTestKey()
    mockJwksFetch(key)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(key, { iss: 'someone-else', aud: AUDIENCE, iat: now, exp: now + 60 })
    await expect(verifyChatJwt(jwt, AUDIENCE)).rejects.toThrow(/unexpected issuer/)
  })

  it('rejects wrong audience', async () => {
    const key = await generateTestKey()
    mockJwksFetch(key)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(key, {
      iss: CHAT_ISSUER,
      aud: 'https://wrong.example/chat/webhook',
      iat: now,
      exp: now + 60,
    })
    await expect(verifyChatJwt(jwt, AUDIENCE)).rejects.toThrow(/unexpected audience/)
  })

  it('rejects expired tokens', async () => {
    const key = await generateTestKey()
    mockJwksFetch(key)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(key, {
      iss: CHAT_ISSUER,
      aud: AUDIENCE,
      iat: now - 120,
      exp: now - 60,
    })
    await expect(verifyChatJwt(jwt, AUDIENCE)).rejects.toThrow(/expired/)
  })

  it('rejects malformed JWTs', async () => {
    await expect(verifyChatJwt('not.a.jwt', AUDIENCE)).rejects.toThrow(/malformed/)
    await expect(verifyChatJwt('only-two.parts', AUDIENCE)).rejects.toThrow(/malformed/)
  })

  it('rejects when the signature does not match', async () => {
    const key = await generateTestKey()
    mockJwksFetch(key)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(key, {
      iss: CHAT_ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 60,
    })
    // Flip a byte in the signature segment
    const parts = jwt.split('.')
    const sig = parts[2]!
    const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, -2)}${sig.endsWith('A') ? 'BB' : 'AA'}`
    await expect(verifyChatJwt(tampered, AUDIENCE)).rejects.toThrow()
  })

  it('rejects an unknown kid (JWKS has a different key)', async () => {
    const signingKey = await generateTestKey('signing-kid')
    const servingKey = await generateTestKey('serving-kid')
    mockJwksFetch(servingKey)
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(signingKey, {
      iss: CHAT_ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 60,
    })
    await expect(verifyChatJwt(jwt, AUDIENCE)).rejects.toThrow(/unknown kid/)
  })

  it('caches JWKS across calls within TTL', async () => {
    const key = await generateTestKey()
    const calls = { count: 0 }
    mockJwksFetch(key, { calls })
    const now = Math.floor(Date.now() / 1000)
    const jwt = await signJwt(key, {
      iss: CHAT_ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 60,
    })
    await verifyChatJwt(jwt, AUDIENCE)
    await verifyChatJwt(jwt, AUDIENCE)
    await verifyChatJwt(jwt, AUDIENCE)
    expect(calls.count).toBe(1)
  })
})
