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
import { OutcomesRepo } from '@/db/repos/outcomes'
import { ChatRepo } from '@/db/repos/chat'
import { MetabaseClient } from '@/clients/metabase'
import { GoogleAdsClient } from '@/clients/googleAds'
import { GoogleChatClient, buildRecommendationCard } from '@/clients/googleChat'
import { runModelsForAccount } from '@/pipeline/runModels'
import { uuid } from '@/lib/uuid'
import { mapRows } from '@/db/rowMapper'

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

    // Idempotency: skip if we've already posted an outbound card for this rec.
    // The chat_messages table is the durable dedupe key: an outbound row exists
    // iff we have already (or attempted to) post a card.
    const priorMessages = await chatRepo.listByRecommendation(rec.recommendation_id)
    const alreadySent = priorMessages.some((m) => m.direction === 'outbound')
    if (alreadySent) {
      // Reconcile drift: if status is still 'pending' but a card was sent,
      // bring the status forward so subsequent passes see the final state.
      if (rec.status === 'pending') {
        await recsRepo.setStatus(rec.recommendation_id, 'sent_to_chat')
      }
      skipped.push(rec.recommendation_id)
      continue
    }

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

    // Insert the outbound chat_messages row FIRST (in-flight marker). If the
    // insert fails no post happened — safe to retry. If the insert succeeds
    // but the post fails, the row remains as a "do-not-retry" guard so we
    // never double-post the same card to Google Chat. Operators can manually
    // delete a stuck row to retry — accepted trade-off vs duplicate cards.
    try {
      await chatRepo.insert({
        message_id: uuid(),
        recommendation_id: rec.recommendation_id,
        account_id: rec.account_id,
        direction: 'outbound',
        space_id: null,
        thread_id: null,
        payload: JSON.stringify(card),
      })
    } catch (e) {
      errors.push({
        id: rec.recommendation_id,
        error: `chat_messages_insert_failed: ${(e as Error).message}`,
      })
      continue
    }

    try {
      await chat.postCard(webhookUrl, card)
      await recsRepo.setStatus(rec.recommendation_id, 'sent_to_chat')
      sent.push(rec.recommendation_id)
    } catch (e) {
      // Post failed but the chat_messages row exists; next cron skips this rec.
      errors.push({
        id: rec.recommendation_id,
        error: (e as Error).message,
      })
    }
  }
  return c.json({ sent: sent.length, skipped: skipped.length, errors })
})

// ---------------------------------------------------------------------------
// POST /cron/outcomes/24h    (daily 07:00 UTC)
// POST /cron/outcomes/72h    (daily 08:00 UTC)
// ---------------------------------------------------------------------------
//
// For each successful execution whose `completed_at` falls in the 6-hour grace
// band ending `hours` ago, pull the realised cost/revenue/conversions from
// Metabase (`raw.gogroup_google_ads`, daily grain), compute deltas vs the
// recommendation's expected_*, and write a row to `execution_outcomes`.
//
// Actuals are approximated to day-grain because `raw.gogroup_google_ads` is
// daily; precise hourly windows would require an hourly mart that does not
// yet exist consistently. We sum [day-of-execution .. day + ceil(hours/24)].
//
// Schema mapping (the DDL uses observed_* columns, not the plan's *_actual):
//   - cost_actual_brl   -> observed_cost_brl
//   - revenue_actual_brl-> observed_revenue_brl
//   - roas_actual       -> observed_roas
//   - cost delta        -> expected_vs_actual_cost_delta   (pct vs expected)
//   - revenue delta     -> expected_vs_actual_revenue_delta(pct vs expected)
//   - verdict           -> packed into `notes` as JSON

interface CandidateExecRow {
  execution_id: string
  recommendation_id: string
  account_id: string
  completed_at: string
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}

function addDaysIso(iso: string, n: number): string {
  const ms = Date.parse(iso) + n * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Fetch cost/revenue/conversions actuals from the daily Data Mart, summed
 * across the inclusive date range [dateStart..dateEnd].
 */
async function fetchActualsForCampaign(
  metabase: MetabaseClient,
  company: string,
  campaignId: string,
  dateStart: string,
  dateEnd: string,
): Promise<{ cost: number; revenue: number; conversions: number }> {
  const escapedCompany = company.replace(/'/g, "''")
  // campaign_id is numeric in the Data Mart but stored as TEXT in our DB.
  const campaignIdNum = Number(campaignId)
  if (!Number.isFinite(campaignIdNum)) {
    return { cost: 0, revenue: 0, conversions: 0 }
  }
  const sql = `
    SELECT COALESCE(SUM(cost), 0)        AS cost,
           COALESCE(SUM(revenue), 0)     AS revenue,
           COALESCE(SUM(conversions), 0) AS conversions
    FROM raw.gogroup_google_ads
    WHERE company = '${escapedCompany}'
      AND campaign_id = ${campaignIdNum}
      AND date BETWEEN '${dateStart}' AND '${dateEnd}'
  `
  const rows = await metabase.querySql<{
    cost: number | string
    revenue: number | string
    conversions: number | string
  }>(sql)
  if (rows.length === 0) return { cost: 0, revenue: 0, conversions: 0 }
  const r = rows[0]!
  return {
    cost: Number(r.cost) || 0,
    revenue: Number(r.revenue) || 0,
    conversions: Number(r.conversions) || 0,
  }
}

async function computeOutcomesWindow(
  env: Env,
  hours: 24 | 72,
  nowMs: number = Date.now(),
): Promise<{ computed: number; skipped: number; errors: string[] }> {
  const { metabase } = buildClients(env)
  if (!metabase) {
    return { computed: 0, skipped: 0, errors: ['metabase_unavailable'] }
  }

  const outcomesRepo = new OutcomesRepo(env.DB)
  const recsRepo = new RecommendationsRepo(env.DB)
  const accountsRepo = new AccountsRepo(env.DB)

  // Window of executions to consider: completed between [now - hours - 6h, now - hours).
  const upperMs = nowMs - hours * 60 * 60 * 1000
  const lowerMs = upperMs - 6 * 60 * 60 * 1000
  const upperIso = new Date(upperMs).toISOString()
  const lowerIso = new Date(lowerMs).toISOString()

  const result = await env.DB.query(
    `SELECT execution_id, recommendation_id, account_id, completed_at
       FROM executions
      WHERE status = ? AND completed_at >= ? AND completed_at < ?`,
    ['success', lowerIso, upperIso],
  )
  const candidates = mapRows<CandidateExecRow>(result.columns, result.rows)

  const windowLabel: '24h' | '72h' = hours === 24 ? '24h' : '72h'
  let computed = 0
  let skipped = 0
  const errors: string[] = []

  for (const exec of candidates) {
    // Idempotency: skip if we already wrote an outcome for this rec+window.
    const existing = await outcomesRepo.listByRecommendation(
      exec.recommendation_id,
    )
    if (existing.some((o) => o.window === windowLabel)) {
      skipped++
      continue
    }

    try {
      const rec = await recsRepo.getById(exec.recommendation_id)
      if (!rec) {
        skipped++
        continue
      }

      // Resolve the company string for the Data Mart query.
      const acc = await accountsRepo.get(rec.account_id)
      const company = acc?.company ?? 'Apice'

      // Daily-grain window: [day-of-completion .. day + ceil(hours/24)].
      const startDate = dateOnly(exec.completed_at)
      const endDate = addDaysIso(exec.completed_at, Math.ceil(hours / 24))

      const actuals = await fetchActualsForCampaign(
        metabase,
        company,
        rec.campaign_id,
        startDate,
        endDate,
      )
      const roasActual = actuals.cost > 0 ? actuals.revenue / actuals.cost : null

      const expRev = rec.expected_incremental_revenue_brl
      const expCost = rec.expected_incremental_cost_brl
      const revVsExp =
        expRev !== null && expRev !== 0
          ? (actuals.revenue - expRev) / Math.abs(expRev)
          : null
      const costVsExp =
        expCost !== null && expCost !== 0
          ? (actuals.cost - expCost) / Math.abs(expCost)
          : null

      let verdict: 'inconclusive' | 'as_expected' | 'better_than_expected' | 'worse'
      if (expRev === null || revVsExp === null) {
        verdict = 'inconclusive'
      } else if (Math.abs(revVsExp) <= 0.1) {
        verdict = 'as_expected'
      } else if (revVsExp > 0.1) {
        verdict = 'better_than_expected'
      } else {
        verdict = 'worse'
      }

      const notes = JSON.stringify({
        verdict,
        window_start_date: startDate,
        window_end_date: endDate,
        company,
        source: 'raw.gogroup_google_ads',
        grain: 'daily',
        note: 'actuals approximated to day-grain; precise hourly granularity not available',
      })

      await outcomesRepo.insert({
        outcome_id: uuid(),
        execution_id: exec.execution_id,
        recommendation_id: exec.recommendation_id,
        account_id: rec.account_id,
        window: windowLabel,
        observed_cost_brl: actuals.cost,
        observed_revenue_brl: actuals.revenue,
        observed_roas: roasActual,
        observed_conversions: actuals.conversions,
        expected_vs_actual_cost_delta: costVsExp,
        expected_vs_actual_revenue_delta: revVsExp,
        notes,
      })
      computed++
    } catch (e) {
      errors.push(`exec=${exec.execution_id}: ${(e as Error).message}`)
    }
  }

  return { computed, skipped, errors }
}

cronRouter.post('/outcomes/24h', async (c) =>
  c.json(await computeOutcomesWindow(c.env, 24)),
)
cronRouter.post('/outcomes/72h', async (c) =>
  c.json(await computeOutcomesWindow(c.env, 72)),
)
