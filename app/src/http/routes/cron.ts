// src/http/routes/cron.ts
//
// Cron entry points. All routes mounted under /cron/* are POST-only and
// guarded by `requireCronKey` (the Godeploy scheduler stamps the
// `X-Godeploy-Cron` header on every fire).
//
// Design notes
// ------------
// - Every handler returns HTTP 200, even on no-op (skipped due to missing
//   env). Non-200 responses make the platform retry the cron, which is
//   undesirable for jobs whose only failure mode is "creds not yet
//   provisioned". The body always carries enough context to debug.
// - `run-models` and `send-to-chat` are the live (production-bearing)
//   handlers. The two `outcomes/*` handlers are deliberate stubs for Phase
//   7.2; the SQL to compute actuals from Metabase will be ported in 8.2.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { requireCronKey } from '../middleware'
import { AccountsRepo } from '@/db/repos/accounts'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { ChatRepo } from '@/db/repos/chat'
import { MetabaseClient } from '@/clients/metabase'
import { GoogleAdsClient } from '@/clients/googleAds'
import { GoogleChatClient, buildRecommendationCard } from '@/clients/googleChat'
import { runModelsForAccount } from '@/pipeline/runModels'
import { uuid } from '@/lib/uuid'

export const cronRouter = new Hono<{ Bindings: Env }>()
cronRouter.use('*', requireCronKey)

interface BuiltClients {
  metabase: MetabaseClient | null
  googleAds: GoogleAdsClient | null
}

function buildClients(env: Env): BuiltClients {
  const metabase =
    env.METABASE_URL && env.METABASE_API_KEY && env.METABASE_DATABASE_ID
      ? new MetabaseClient({
          url: env.METABASE_URL,
          apiKey: env.METABASE_API_KEY,
          databaseId: Number(env.METABASE_DATABASE_ID),
        })
      : null
  const googleAds =
    env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    env.GOOGLE_ADS_CLIENT_ID &&
    env.GOOGLE_ADS_CLIENT_SECRET &&
    env.GOOGLE_ADS_REFRESH_TOKEN &&
    env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
      ? new GoogleAdsClient({
          developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
          clientId: env.GOOGLE_ADS_CLIENT_ID,
          clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
          refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
          loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
        })
      : null
  return { metabase, googleAds }
}

// ---------------------------------------------------------------------------
// POST /cron/run-models     (daily 06:00 UTC)
// ---------------------------------------------------------------------------
cronRouter.post('/run-models', async (c) => {
  const { metabase, googleAds } = buildClients(c.env)
  if (!metabase || !googleAds) {
    return c.json({
      skipped: true,
      reason: 'env_missing',
      missing: { metabase: !metabase, googleAds: !googleAds },
    })
  }
  const accounts = await new AccountsRepo(c.env.DB).listActive()
  const nowIso = new Date().toISOString()
  const results: unknown[] = []
  for (const acc of accounts) {
    const loginCustomerId =
      acc.login_customer_id ?? c.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    if (!loginCustomerId) {
      results.push({
        accountId: acc.account_id,
        error: 'missing_login_customer_id',
      })
      continue
    }
    try {
      const r = await runModelsForAccount(
        c.env.DB,
        metabase,
        googleAds,
        {
          accountId: acc.account_id,
          loginCustomerId,
          windowDays: 60,
        },
        nowIso,
      )
      results.push({ accountId: acc.account_id, ...r })
    } catch (e) {
      results.push({
        accountId: acc.account_id,
        error: (e as Error).message,
      })
    }
  }
  return c.json({ ran: results.length, results })
})

// ---------------------------------------------------------------------------
// POST /cron/send-to-chat    (every 15 minutes)
// ---------------------------------------------------------------------------
cronRouter.post('/send-to-chat', async (c) => {
  const webhookUrl = c.env.GOOGLE_CHAT_WEBHOOK_URL
  if (!webhookUrl) {
    return c.json({ skipped: true, reason: 'no_webhook' })
  }
  const recsRepo = new RecommendationsRepo(c.env.DB)
  const chatRepo = new ChatRepo(c.env.DB)
  const chat = new GoogleChatClient()
  const pending = await recsRepo.listByStatus('pending', 50)
  const sent: string[] = []
  const skipped: string[] = []
  const errors: Array<{ id: string; error: string }> = []
  for (const rec of pending) {
    if (rec.guardrail_status === 'blocked') {
      skipped.push(rec.recommendation_id)
      continue
    }
    try {
      const card = buildRecommendationCard({
        recommendationId: rec.recommendation_id,
        headline: `${rec.recommended_action} em ${rec.campaign_name}`,
        campaign: rec.campaign_name,
        changePercent: rec.change_percent,
        expectedRevenueBrl: rec.expected_incremental_revenue_brl,
        expectedCostBrl: rec.expected_incremental_cost_brl,
        marginalRoas: rec.expected_marginal_roas,
        confidence: rec.confidence_score,
        risk: rec.risk_level,
        guardrailStatus: rec.guardrail_status as
          | 'ok'
          | 'needs_human_review'
          | 'blocked',
      })
      await chat.postCard(webhookUrl, card)
      await chatRepo.insert({
        message_id: uuid(),
        recommendation_id: rec.recommendation_id,
        account_id: rec.account_id,
        direction: 'outbound',
        space_id: null,
        thread_id: null,
        payload: JSON.stringify(card),
      })
      await recsRepo.setStatus(rec.recommendation_id, 'sent_to_chat')
      sent.push(rec.recommendation_id)
    } catch (e) {
      errors.push({
        id: rec.recommendation_id,
        error: (e as Error).message,
      })
    }
  }
  return c.json({ sent: sent.length, skipped: skipped.length, errors })
})

// ---------------------------------------------------------------------------
// POST /cron/outcomes/24h    (daily 07:00 UTC)  [STUB — Phase 8.2]
// POST /cron/outcomes/72h    (daily 08:00 UTC)  [STUB — Phase 8.2]
// ---------------------------------------------------------------------------
//
// Outcome computation requires porting `legacy/python/queries/12_decision_backtest.sql`
// (per-campaign actuals from Metabase aligned to the rec's expected_*). Until
// that lands the route is wired up so the platform cron entry exists and we
// can see the schedule fire end-to-end — it just returns 0 counters.
function stubOutcomes(env: Env, hours: 24 | 72): {
  computed: number
  skipped: number
  errors: string[]
} {
  const { metabase } = buildClients(env)
  if (!metabase) {
    return { computed: 0, skipped: 0, errors: ['metabase_unavailable'] }
  }
  return {
    computed: 0,
    skipped: 0,
    errors: [`stub_not_yet_implemented_window=${hours}h`],
  }
}

cronRouter.post('/outcomes/24h', (c) => c.json(stubOutcomes(c.env, 24)))
cronRouter.post('/outcomes/72h', (c) => c.json(stubOutcomes(c.env, 72)))
