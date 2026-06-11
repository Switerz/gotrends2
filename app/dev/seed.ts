// dev/seed.ts
//
// Realistic seed data for local development. Populates 3 model runs, ~30
// recommendations spanning every status + guardrail combo, and a handful of
// execution attempts so every UI page in the React client renders with data.
//
// Idempotent: re-running with an existing populated DB is a no-op.

import { randomUUID } from 'node:crypto'

import type { GodeployDB } from '../src/db/bootstrap'
import { persistDecision } from '../src/agent/tools/persistDecision'
import { RunsRepo } from '../src/db/repos/runs'
import { RecommendationsRepo } from '../src/db/repos/recommendations'
import { ExecutionsRepo } from '../src/db/repos/executions'
import { OutcomesRepo } from '../src/db/repos/outcomes'
import type { RecommendationStatus } from '../src/db/types'

const ACCOUNT_ID = '7705857660'

const CAMPAIGNS = [
  { id: 'c-001', name: 'Search - Brand Apice', type: 'search' },
  { id: 'c-002', name: 'Shopping - Eyewear', type: 'shopping' },
  { id: 'c-003', name: 'Performance Max - All Products', type: 'performance_max' },
  { id: 'c-004', name: 'Display - Remarketing', type: 'display' },
  { id: 'c-005', name: 'Search - NB Categories', type: 'search' },
] as const

const ACTIONS = [
  'increase_budget',
  'reduce_budget',
  'increase_troas_or_reduce_budget',
  'optimize_efficiency',
  'monitor',
] as const

const RISKS: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high']

const STATUSES: RecommendationStatus[] = [
  'pending',
  'sent_to_chat',
  'approved',
  'rejected',
  'executed',
  'failed',
  'expired',
]

interface Candidate {
  account_id: string
  campaign_id: string
  campaign_name: string
  skill_type: string
  recommended_action: (typeof ACTIONS)[number]
  change_percent: number | null
  current_budget_brl: number | null
  current_target_roas: number | null
  expected_marginal_roas: number | null
  confidence_score: number
  risk_level: 'low' | 'medium' | 'high'
  reason: string
}

/** Deterministic-ish candidate generator. ~10% are above the guardrail limit
 *  (>=60% change_percent) so we cover the `blocked`/`needs_human_review` paths. */
function buildCandidate(idx: number): Candidate {
  const c = CAMPAIGNS[idx % CAMPAIGNS.length]!
  const action = ACTIONS[idx % ACTIONS.length]!
  const changeMag = ((idx % 5) + 1) * 0.07 // 0.07 .. 0.35
  const sign = idx % 2 === 0 ? 1 : -1
  const aboveLimit = idx % 11 === 0 // ~10% trigger guardrails
  const change =
    action === 'increase_budget'
      ? changeMag
      : action === 'reduce_budget'
        ? -changeMag
        : action === 'monitor'
          ? null
          : sign * changeMag
  const confidence = action === 'monitor' ? 30 + (idx % 10) : 55 + (idx % 40)
  const baseBudget = 500 + (idx % 5) * 250
  const marginalRoas = 1.5 + (idx % 7) * 0.4
  const risk = RISKS[idx % 3]!
  return {
    account_id: ACCOUNT_ID,
    campaign_id: c.id,
    campaign_name: c.name,
    skill_type: action === 'monitor' ? 'anomaly_alert' : 'budget_reallocation',
    recommended_action: action,
    change_percent: aboveLimit ? 0.65 : change,
    current_budget_brl: baseBudget,
    current_target_roas: c.type === 'shopping' ? 3.5 : null,
    expected_marginal_roas: marginalRoas,
    confidence_score: confidence,
    risk_level: risk,
    reason:
      action === 'increase_budget'
        ? 'scale_opportunity'
        : action === 'reduce_budget'
          ? 'efficiency_risk'
          : 'monitor_only',
  }
}

export interface SeedResult {
  runs: number
  recommendations: number
  executions: number
  outcomes: number
}

export async function seedDevData(db: GodeployDB): Promise<SeedResult> {
  // Idempotency: bail out if there's already data.
  const existing = await db.query(`SELECT COUNT(*) AS n FROM recommendations`)
  const rowZero = existing.rows[0]
  const existingCount: number = Array.isArray(rowZero)
    ? (Number((rowZero as unknown[])[0]) || 0)
    : rowZero && typeof rowZero === 'object'
      ? (Number((rowZero as Record<string, unknown>)['n']) || 0)
      : 0
  if (existingCount > 0) {
    return { runs: 0, recommendations: 0, executions: 0, outcomes: 0 }
  }

  const runsRepo = new RunsRepo(db)
  const recsRepo = new RecommendationsRepo(db)
  const execsRepo = new ExecutionsRepo(db)
  const outcomesRepo = new OutcomesRepo(db)

  const now = new Date()
  const windowEnd = now.toISOString().slice(0, 10)
  const windowStart = new Date(now.getTime() - 60 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10)

  // 3 runs (today, yesterday, last week)
  const runs = [
    { status: 'success' as const, n_campaigns: 5, n_recs: 12 },
    { status: 'success' as const, n_campaigns: 5, n_recs: 10 },
    { status: 'success' as const, n_campaigns: 5, n_recs: 8 },
  ]
  const createdRunIds: string[] = []
  for (const r of runs) {
    const runId = randomUUID()
    createdRunIds.push(runId)
    await runsRepo.insert({
      run_id: runId,
      account_id: ACCOUNT_ID,
      pipeline_version: '0.1.0',
      status: r.status,
      n_campaigns_scanned: r.n_campaigns,
      n_recommendations: r.n_recs,
      input_window_start: windowStart,
      input_window_end: windowEnd,
      notes: null,
    })
  }

  let nRecs = 0
  let nExecs = 0
  let nOutcomes = 0

  for (let i = 0; i < 30; i++) {
    const runId = createdRunIds[i % createdRunIds.length]!
    const candidate = buildCandidate(i)
    const recId = randomUUID()

    try {
      await persistDecision(db, candidate, { runId, recommendationId: recId })
    } catch {
      // Refiner rejected the candidate — skip it. We have plenty of others.
      continue
    }
    nRecs++

    // Spread across all statuses so the UI shows every state.
    const targetStatus = STATUSES[i % STATUSES.length]!
    if (targetStatus !== 'pending') {
      await recsRepo.setStatus(recId, targetStatus)
    }

    // Statuses that imply at least one Google Ads mutate attempt.
    if (targetStatus === 'executed' || targetStatus === 'failed') {
      const execId = randomUUID()
      const success = targetStatus === 'executed'
      await execsRepo.insert({
        execution_id: execId,
        recommendation_id: recId,
        account_id: ACCOUNT_ID,
        attempt_number: 1,
        status: success ? 'success' : 'failed',
        google_ads_request: JSON.stringify({
          budgetResource: `customers/${ACCOUNT_ID}/campaignBudgets/${candidate.campaign_id}_budget`,
          amountMicros: '1100000000',
        }),
        google_ads_response: success
          ? JSON.stringify({
              resourceName: `customers/${ACCOUNT_ID}/campaignBudgets/${candidate.campaign_id}_budget`,
            })
          : null,
        error_message: success
          ? null
          : '[mutate_failed] dev simulation: rate limit',
        completed_at: new Date().toISOString(),
      })
      nExecs++

      // Add a 24h outcome for the successful ones so the UI's outcome views
      // have something to show.
      if (success) {
        await outcomesRepo.insert({
          outcome_id: randomUUID(),
          recommendation_id: recId,
          execution_id: execId,
          account_id: ACCOUNT_ID,
          window: '24h',
          observed_cost_brl: (candidate.current_budget_brl ?? 500) * 1.08,
          observed_revenue_brl:
            (candidate.current_budget_brl ?? 500) *
            1.08 *
            (candidate.expected_marginal_roas ?? 2),
          observed_roas: candidate.expected_marginal_roas ?? 2,
          observed_conversions: 12 + (i % 5),
          expected_vs_actual_cost_delta: -0.03,
          expected_vs_actual_revenue_delta: 0.04,
          notes: null,
        })
        nOutcomes++
      }
    }
  }

  return {
    runs: createdRunIds.length,
    recommendations: nRecs,
    executions: nExecs,
    outcomes: nOutcomes,
  }
}
