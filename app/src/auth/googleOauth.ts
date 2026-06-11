// src/auth/googleOauth.ts
//
// Helpers for the OAuth 2.0 Authorization Code flow against Google's OIDC
// endpoints. We only ever request `openid email profile` (no offline scope —
// the session cookie carries identity, refresh tokens add no value here).

import type { Env } from '@/index'

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo'

const DEFAULT_APP_ORIGIN = 'https://gotrends-agent.devgogroup.com'

function redirectUri(env: Env): string {
  return `${env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN}/api/auth/callback`
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  })
  return `${GOOGLE_AUTH}?${params}`
}

export interface OauthUser {
  email: string
  name: string
}

export async function exchangeCode(env: Env, code: string): Promise<OauthUser> {
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri(env),
      grant_type: 'authorization_code',
      code,
    }),
  })
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    throw new Error(`token exchange failed: ${tokenRes.status} ${body.slice(0, 300)}`)
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string }
  if (!tokenJson.access_token) throw new Error('token exchange returned no access_token')

  const userRes = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  })
  if (!userRes.ok) throw new Error(`userinfo failed: ${userRes.status}`)
  const profile = (await userRes.json()) as { email?: string; name?: string }
  if (!profile.email) throw new Error('userinfo returned no email')
  return { email: profile.email, name: profile.name ?? profile.email }
}
