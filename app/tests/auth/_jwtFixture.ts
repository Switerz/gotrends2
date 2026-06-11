// tests/auth/_jwtFixture.ts
//
// Reusable RS256 signing fixture for tests that need a Google-Chat-shaped JWT.
// Generates one keypair per test setup, exposes a mocked `fetch` that serves
// the matching JWKS, and emits signed tokens with arbitrary claims.

import { vi } from 'vitest'
import { CHAT_ISSUER, CHAT_JWKS_URL, _resetJwksCacheForTests } from '@/auth/googleJwt'

interface Fixture {
  signJwt: (claims: Record<string, unknown>) => Promise<string>
  installFetchMock: () => void
  /** @returns false until `installFetchMock` was called. */
  hasMock: () => boolean
  kid: string
}

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function makeJwtFixture(kid = 'test-fixture-kid'): Promise<Fixture> {
  _resetJwksCacheForTests()
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
  let installed = false

  return {
    kid,
    hasMock: () => installed,
    installFetchMock() {
      installed = true
      const jwk = {
        kid,
        kty: 'RSA',
        alg: 'RS256',
        use: 'sig',
        n: publicJwk.n,
        e: publicJwk.e,
      }
      // Wrap, not replace — chatWebhook.test.ts also spies fetch for execute.
      const realFetch = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url === CHAT_JWKS_URL) {
          return new Response(JSON.stringify({ keys: [jwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return realFetch(input, init)
      })
    },
    async signJwt(claims) {
      const header = { alg: 'RS256', typ: 'JWT', kid }
      const headerB64 = b64url(JSON.stringify(header))
      const payloadB64 = b64url(JSON.stringify(claims))
      const signingInput = `${headerB64}.${payloadB64}`
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          kp.privateKey,
          new TextEncoder().encode(signingInput),
        ),
      )
      return `${signingInput}.${b64url(sig)}`
    },
  }
}

/** Convenience: a standard valid-claims JWT for the default audience. */
export async function makeValidChatJwt(
  fixture: Fixture,
  audience = 'https://gotrends-agent.devgogroup.com/chat/webhook',
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return fixture.signJwt({
    iss: CHAT_ISSUER,
    aud: audience,
    iat: now,
    exp: now + 60,
  })
}
