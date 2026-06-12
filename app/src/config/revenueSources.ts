// src/config/revenueSources.ts
//
// Per-account revenue source configuration. Maps a Google Ads `account_id`
// to the e-commerce platform that holds the ground-truth revenue for that
// account. The pipeline uses Google Ads `conversion_value` as a proxy
// today; when this mapping is wired in, the proxy is replaced by the real
// revenue per campaign (joined via UTM tags on the order).
//
// Multi-company by construction: every account stands alone, can use a
// different provider, and references its own credentials. Adding a new
// account = appending one entry below + setting the matching secrets.
//
// Credential VALUES are never in this file or any tracked file — only the
// NAMES of the env vars where the runtime can read them via Godeploy's
// `setAppSecret`. This keeps the repo safe and the rotation story clean.

import type { Env } from '@/index'

/** Provider tag. New providers (Shopify, Vtex, ...) add a literal here and
 *  a matching client + config interface. */
export type RevenueProvider = 'yampi'

/** Yampi REST API credentials — only env var names, never values. */
export interface YampiCredentialRefs {
  /** Env var name for the `User-Token` header. */
  userTokenEnv: keyof Env
  /** Env var name for the `User-Secret-Key` header. */
  userSecretKeyEnv: keyof Env
}

export interface YampiRevenueSource {
  provider: 'yampi'
  /** URL-slug used in `https://api.dooki.com.br/v2/{alias}/...`. Not sensitive. */
  alias: string
  credentials: YampiCredentialRefs
}

export type RevenueSourceConfig = YampiRevenueSource

/**
 * Account-id → revenue source. Read by the pipeline when computing the
 * revenue series for a run. Account not present in this map → pipeline
 * falls back to `conversion_value` from Google Ads (the legacy proxy).
 *
 * Keep the map small and explicit; don't auto-generate from DB rows.
 * Configuration changes deserve a code review.
 */
export const REVENUE_SOURCES: Record<string, RevenueSourceConfig> = {
  // Apice / GoGroup — primary account, e-commerce on Yampi.
  '7705857660': {
    provider: 'yampi',
    alias: 'apice-cosmeticos',
    credentials: {
      userTokenEnv: 'YAMPI_APICE_USER_TOKEN',
      userSecretKeyEnv: 'YAMPI_APICE_USER_SECRET_KEY',
    },
  },
}

/** Return the configured revenue source for an account, or null if none. */
export function getRevenueSource(accountId: string): RevenueSourceConfig | null {
  return REVENUE_SOURCES[accountId] ?? null
}
