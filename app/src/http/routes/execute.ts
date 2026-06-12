// src/http/routes/execute.ts
//
// POST /api/execute/:id — apply a Google Ads mutate for an approved recommendation.
//
// Lifecycle on a given recommendation:
//   pending → approved → executing → executed   (happy path)
//                              ↘  failed       (mutate threw)
//
// Idempotency:
//   - 404 when no row matches :id
//   - 409 when status is not 'approved' (already executed / pending / rejected / …)
//   - 409 when guardrail_status='blocked' (refiner gate)
//   - retries on a previously 'failed' recommendation are NOT supported by the
//     status machine, but a new execution row with attempt_number+1 is recorded
//     whenever a retry IS performed (e.g. via test injection that resets the
//     row to 'approved').
//
// Google Ads client is built from `c.env` secrets. For unit tests, a factory
// override is exposed via `executeRouterFactory(clientFactory)` so the test can
// inject a fake `GoogleAdsClient`.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { GoogleAdsClient } from '@/clients/googleAds'
import { ExecutionsRepo } from '@/db/repos/executions'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { uuid } from '@/lib/uuid'
import { requireExecuteToken } from '../middleware'

/** Factory that constructs (or returns null) a GoogleAdsClient from env secrets. */
export type GoogleAdsClientFactory = (env: Env) => GoogleAdsClient | null

/** Default factory: reads OAuth + developer token secrets from `env`. Returns null when any are missing. */
export const buildGoogleAdsClient: GoogleAdsClientFactory = (env) => {
  if (
    !env.GOOGLE_ADS_DEVELOPER_TOKEN ||
    !env.GOOGLE_ADS_CLIENT_ID ||
    !env.GOOGLE_ADS_CLIENT_SECRET ||
    !env.GOOGLE_ADS_REFRESH_TOKEN ||
    !env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
  ) {
    return null
  }
  return new GoogleAdsClient({
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  })
}

/**
 * Build the executor router. Accepts an optional `clientFactory` so tests can
 * inject a fake `GoogleAdsClient` without having to fully populate `env`.
 */
export function executeRouterFactory(
  clientFactory: GoogleAdsClientFactory = buildGoogleAdsClient,
): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>()
  router.use('*', requireExecuteToken)

  router.post('/:id', async (c) => {
    const recsRepo = new RecommendationsRepo(c.env.DB)
    const execsRepo = new ExecutionsRepo(c.env.DB)

    const recommendationId = c.req.param('id')
    const rec = await recsRepo.getById(recommendationId)
    if (!rec) {
      return c.json({ error: 'recommendation_not_found' }, 404)
    }

    if (rec.status === 'executed' || rec.status === 'executing') {
      return c.json(
        { error: 'already_executed_or_in_progress', currentStatus: rec.status },
        409,
      )
    }
    if (rec.status !== 'approved') {
      return c.json({ error: 'not_approved', currentStatus: rec.status }, 409)
    }
    if (rec.guardrail_status === 'blocked') {
      return c.json(
        { error: 'blocked_by_guardrail', reason: rec.guardrail_reason },
        409,
      )
    }

    // Compute attempt_number based on prior executions for this rec.
    const prior = await execsRepo.listByRecommendation(rec.recommendation_id)
    const attempt = prior.length + 1
    const executionId = uuid()

    // Build the Google Ads client BEFORE inserting any row, so a misconfigured
    // env fails cleanly with no orphaned 'pending' execution row.
    const adsClient = clientFactory(c.env)
    if (!adsClient) {
      return c.json({ error: 'env_missing' }, 500)
    }

    // Insert pending execution row + flip recommendation to 'executing'.
    await execsRepo.insert({
      execution_id: executionId,
      recommendation_id: rec.recommendation_id,
      account_id: rec.account_id,
      attempt_number: attempt,
      status: 'pending',
      google_ads_request: null,
      google_ads_response: null,
      error_message: null,
      completed_at: null,
      verified_at: null,
      verification_status: null,
      verified_value: null,
    })
    await recsRepo.setStatus(rec.recommendation_id, 'executing')

    // DRY_RUN_EXECUTE='1' (string) → log + synthesize a successful mutate
    // without calling Google Ads. Used to smoke the approval loop on first
    // deploys without mutating real campaign budgets. Any other value or
    // unset = real mutate.
    const dryRun = c.env.DRY_RUN_EXECUTE === '1'

    try {
      let response: { resourceName: string }
      // Request payload kinds we persist. Both shapes carry `kind` so the
      // dry-run branch can identify which resource to echo back in the
      // synthetic resourceName without resorting to `any` casts.
      type BudgetReq = {
        kind: 'mutateBudget'
        customerId: string
        budgetResource: string
        amountMicros: number
      }
      type RoasReq = {
        kind: 'mutateCampaignTargetRoas'
        customerId: string
        campaignResource: string
        targetRoas: number
      }
      let request: BudgetReq | RoasReq

      // Per-action precondition checks. We refuse to assemble a mutate when
      // the rec is missing the data the request requires — fail-closed so
      // Google Ads never receives a malformed payload (e.g. a synthesised
      // budgetResource that doesn't exist). The rec is flipped to 'failed'
      // with a structured `precondition_failed` error so postmortem is cheap.
      const failPrecondition = async (detail: string) => {
        await execsRepo.setStatus(
          executionId,
          'failed',
          new Date().toISOString(),
          'precondition_failed',
          detail,
        )
        await recsRepo.setStatus(rec.recommendation_id, 'failed')
        return c.json(
          {
            executionId,
            status: 'failed',
            error: 'precondition_failed',
            detail,
          },
          422,
        )
      }

      const isTroas = rec.recommended_action === 'increase_troas_or_reduce_budget'
      const isBudget =
        rec.recommended_action === 'increase_budget' ||
        rec.recommended_action === 'reduce_budget'

      if (isTroas) {
        if (rec.proposed_target_roas === null) {
          return failPrecondition('tROAS mutate requires proposed_target_roas')
        }
        // Target ROAS mutate path.
        const campaignResource = `customers/${rec.account_id}/campaigns/${rec.campaign_id}`
        request = {
          kind: 'mutateCampaignTargetRoas',
          customerId: rec.account_id,
          campaignResource,
          targetRoas: rec.proposed_target_roas,
        }
        if (dryRun) {
          console.log(
            JSON.stringify({
              event: 'dry_run_execute',
              executionId,
              recommendationId: rec.recommendation_id,
              campaignId: rec.campaign_id,
              accountId: rec.account_id,
              action: rec.recommended_action,
              request,
            }),
          )
          response = { resourceName: `[dry_run] ${campaignResource}` }
        } else {
          response = await adsClient.mutateCampaignTargetRoas(
            rec.account_id,
            campaignResource,
            rec.proposed_target_roas,
          )
        }
      } else if (isBudget) {
        // Budget mutate path. We use the budget resource name captured by the
        // pipeline at run time (`SELECT campaign_budget.resource_name FROM
        // campaign`). Synthesising it from campaign_id is invalid — the
        // resource id has no fixed relationship to the campaign id and
        // submitting a placeholder yields BAD_RESOURCE_ID from Google Ads.
        if (rec.proposed_budget_brl === null) {
          return failPrecondition('budget mutate requires proposed_budget_brl')
        }
        if (!rec.budget_resource_name) {
          return failPrecondition(
            'budget mutate requires budget_resource_name (pipeline must populate it from campaign_budget.resource_name)',
          )
        }
        const budgetResource = rec.budget_resource_name
        const amountMicros = Math.round(rec.proposed_budget_brl * 1_000_000)
        request = {
          kind: 'mutateBudget',
          customerId: rec.account_id,
          budgetResource,
          amountMicros,
        }
        if (dryRun) {
          console.log(
            JSON.stringify({
              event: 'dry_run_execute',
              executionId,
              recommendationId: rec.recommendation_id,
              campaignId: rec.campaign_id,
              accountId: rec.account_id,
              action: rec.recommended_action,
              request,
            }),
          )
          response = { resourceName: `[dry_run] ${budgetResource}` }
        } else {
          response = await adsClient.mutateBudget(
            rec.account_id,
            budgetResource,
            amountMicros,
          )
        }
      } else {
        // Non-executable action (monitor, pause, improve_ads_or_terms,
        // review_landing_or_offer, optimize_efficiency, …). These should
        // never have reached an executor call — `buildCandidate` already
        // filters monitor/pause out, and approve is exposed only via UI.
        // Treat as a structured precondition failure rather than a 500 so
        // the caller can show a clear message.
        return failPrecondition(
          `recommended_action ${rec.recommended_action} is not executable by this worker`,
        )
      }

      await execsRepo.setStatus(
        executionId,
        'success',
        new Date().toISOString(),
        null,
        // Stash request/response into error_message? No — use a follow-up exec.
        null,
      )
      // Persist the request/response payloads. ExecutionsRepo.setStatus only
      // touches status/completed_at/error_message, so we issue a direct UPDATE.
      // When dry-run, embed a `dry_run: true` marker on the persisted response
      // JSON so the audit row reflects that no real mutate happened. The
      // `executions` schema has no dedicated flag column, so we annotate the
      // existing `google_ads_response` payload (and the resourceName itself
      // carries the `[dry_run]` prefix for at-a-glance scanning).
      const persistedResponse = dryRun
        ? { ...response, dry_run: true }
        : response
      await c.env.DB.exec(
        `UPDATE executions
         SET google_ads_request = ?, google_ads_response = ?
         WHERE execution_id = ?`,
        [JSON.stringify(request), JSON.stringify(persistedResponse), executionId],
      )
      await recsRepo.setStatus(rec.recommendation_id, 'executed')

      return c.json({
        executionId,
        status: 'success',
        resourceName: response.resourceName,
        ...(dryRun ? { dryRun: true } : {}),
      })
    } catch (e) {
      const msg = (e as Error).message
      await execsRepo.setStatus(
        executionId,
        'failed',
        new Date().toISOString(),
        'mutate_failed',
        msg,
      )
      await recsRepo.setStatus(rec.recommendation_id, 'failed')
      return c.json({ executionId, status: 'failed', error: msg }, 502)
    }
  })

  return router
}

/** Default router using the env-based factory; mounted at `/api/execute`. */
export const executeRouter = executeRouterFactory()
