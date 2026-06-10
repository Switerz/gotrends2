/**
 * Guardrails and constrained action selection for GoTrends v2.
 *
 * Port of legacy/python/models/constraints_optimizer.py with 1e-6 parity.
 *
 * Adds five derived columns to each ranked candidate row:
 *  - action_kind: 'budget' | 'bid' | 'other' (mapped from recommended_action)
 *  - business_constraints_status: 'needs_human_review' | 'blocked' (default review)
 *  - constraints_reason: free-text reason key matching the Python sentinel set
 *  - budget_action_rank: per-date cumcount among budget actions (NaN for non-budget)
 *  - bid_action_rank:    per-date cumcount among bid actions    (NaN for non-bid)
 *
 * The block decisions mirror Python's sequential .loc[mask, ...] assignments —
 * later rules overwrite earlier ones. Final priority (lowest → highest):
 *   default 'needs_human_review'
 *   → blocked_by_daily_budget_change_limit  (budget_action_rank > max)
 *   → blocked_by_daily_bid_change_limit     (bid_action_rank > max)
 *   → blocked_by_bid_change_pct_limit       (|recommended_change_pct| > max)
 *   → blocked_by_impression_share           (budget + impression_share >= 0.90)
 */

export interface GuardrailConfig {
  /** Max budget-changing actions allowed per day (rank > limit → blocked). */
  maxBudgetChangesPerDay: number
  /** Max bid-changing actions allowed per day. */
  maxBidChangesPerDay: number
  /** Max absolute bid change pct (|recommended_change_pct| > limit → blocked). */
  maxBidChangePct: number
  /** Max share of initial investment a budget change can represent. (unused MVP) */
  maxBudgetChangeShareOfInitialInvestment: number
  /** Max projected cost-of-sale. (unused MVP) */
  maxProjectedCos: number
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  maxBudgetChangesPerDay: 3,
  maxBidChangesPerDay: 1,
  maxBidChangePct: 0.2,
  maxBudgetChangeShareOfInitialInvestment: 0.4,
  maxProjectedCos: 0.15,
}

export type ActionKind = 'budget' | 'bid' | 'other'

export type BusinessConstraintsStatus = 'needs_human_review' | 'blocked'

export type ConstraintsReason =
  | 'manual_learning_test_and_real_cos_sources_missing'
  | 'blocked_by_daily_budget_change_limit'
  | 'blocked_by_daily_bid_change_limit'
  | 'blocked_by_bid_change_pct_limit'
  | 'blocked_by_impression_share'

export interface GuardrailInputRow {
  date?: unknown
  confidence_score?: number | null
  recommended_action?: string | null
  recommended_change_pct?: number | null
  impression_share?: number | null
  [key: string]: unknown
}

export interface GuardrailOutputRow extends GuardrailInputRow {
  action_kind: ActionKind
  business_constraints_status: BusinessConstraintsStatus
  constraints_reason: ConstraintsReason
  /** null when the row isn't a budget action (Python emits NaN → blank CSV). */
  budget_action_rank: number | null
  /** null when the row isn't a bid action. */
  bid_action_rank: number | null
}

/** Map recommended_action onto a coarse action-kind bucket used by guardrails. */
export function actionKind(action: string | null | undefined): ActionKind {
  if (action === 'increase_budget') return 'budget'
  if (action === 'increase_troas_or_reduce_budget') return 'bid'
  return 'other'
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Stable sort that mirrors pandas .sort_values(['date','confidence_score'],
 * ascending=[True, False]) followed by .groupby('date').cumcount(). Within a
 * date bucket, higher confidence_score gets a lower (better) rank; ties are
 * broken by the original DataFrame row order.
 */
function assignActionRanks<T extends GuardrailInputRow>(
  rows: T[],
  matches: (r: T) => boolean,
): Map<number, number> {
  // Collect indices of matching rows with their stable sort keys.
  const items: Array<{ idx: number; date: string; conf: number }> = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if (!matches(r)) continue
    const date = String(r.date ?? '')
    const conf = isFiniteNum(r.confidence_score) ? r.confidence_score : -Infinity
    items.push({ idx: i, date, conf })
  }
  // Stable sort: date asc, confidence_score desc, original index asc as tiebreaker.
  items.sort((a, b) => {
    if (a.date < b.date) return -1
    if (a.date > b.date) return 1
    if (a.conf !== b.conf) return b.conf - a.conf
    return a.idx - b.idx
  })
  // cumcount per date bucket.
  const rankByIdx = new Map<number, number>()
  let prevDate: string | null = null
  let counter = 0
  for (const it of items) {
    if (it.date !== prevDate) {
      counter = 0
      prevDate = it.date
    }
    counter += 1
    rankByIdx.set(it.idx, counter)
  }
  return rankByIdx
}

/**
 * Apply MVP guardrails to ranked candidate actions.
 *
 * Missing external sources, such as manual block lists and learning status,
 * should be represented by nullable boolean columns when they become available.
 */
export function applyGuardrails<T extends GuardrailInputRow>(
  candidates: T[],
  config: GuardrailConfig = DEFAULT_GUARDRAIL_CONFIG,
): (T & GuardrailOutputRow)[] {
  const n = candidates.length
  const out: (T & GuardrailOutputRow)[] = new Array(n)

  // First pass: shallow-copy + compute action_kind + seed defaults.
  for (let i = 0; i < n; i++) {
    const row = candidates[i]!
    const kind = actionKind(
      typeof row.recommended_action === 'string' ? row.recommended_action : null,
    )
    out[i] = {
      ...row,
      action_kind: kind,
      business_constraints_status: 'needs_human_review',
      constraints_reason: 'manual_learning_test_and_real_cos_sources_missing',
      budget_action_rank: null,
      bid_action_rank: null,
    } as T & GuardrailOutputRow
  }

  // Per-date ranks among budget and bid actions.
  const budgetRanks = assignActionRanks(out, r => r.action_kind === 'budget')
  const bidRanks = assignActionRanks(out, r => r.action_kind === 'bid')
  for (const [i, r] of budgetRanks) out[i]!.budget_action_rank = r
  for (const [i, r] of bidRanks) out[i]!.bid_action_rank = r

  // Apply guardrail rules sequentially. Later rules win, matching Python's
  // ordered .loc[mask, ...] = [...] assignments.
  for (let i = 0; i < n; i++) {
    const row = out[i]!
    const isBudget = row.action_kind === 'budget'
    const isBid = row.action_kind === 'bid'

    // 1. blocked_budget_count: budget_action_rank > maxBudgetChangesPerDay
    if (
      isBudget &&
      row.budget_action_rank !== null &&
      row.budget_action_rank > config.maxBudgetChangesPerDay
    ) {
      row.business_constraints_status = 'blocked'
      row.constraints_reason = 'blocked_by_daily_budget_change_limit'
    }

    // 2. blocked_bid_count: bid_action_rank > maxBidChangesPerDay
    if (
      isBid &&
      row.bid_action_rank !== null &&
      row.bid_action_rank > config.maxBidChangesPerDay
    ) {
      row.business_constraints_status = 'blocked'
      row.constraints_reason = 'blocked_by_daily_bid_change_limit'
    }

    // 3. blocked_bid_pct: |recommended_change_pct| > maxBidChangePct
    const rcp = row.recommended_change_pct
    if (
      isBid &&
      isFiniteNum(rcp) &&
      Math.abs(rcp) > config.maxBidChangePct
    ) {
      row.business_constraints_status = 'blocked'
      row.constraints_reason = 'blocked_by_bid_change_pct_limit'
    }

    // 4. blocked_is: budget + impression_share >= 0.90.
    // pandas .ge(0.90) on a NaN cell returns False → no block.
    const is = row.impression_share
    if (isBudget && isFiniteNum(is) && is >= 0.9) {
      row.business_constraints_status = 'blocked'
      row.constraints_reason = 'blocked_by_impression_share'
    }
  }

  return out
}
