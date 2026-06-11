// src/http/routes/backtest.ts
//
// Aggregation endpoint over `recommendations × execution_outcomes`. Builds one
// backtest row per recommendation that has a follow-up outcome (preferring the
// 72h window, falling back to 24h, then 7d) and runs both `summarizeBacktest`
// and `outcomeCounts` over the result.
//
// Verdict derivation
// ------------------
// The legacy Python module consumes a pre-shaped decision log produced by
// `queries/12_decision_backtest.sql`, which classifies outcomes directly from
// raw metrics. The TS schema (`execution_outcomes`) only stores numeric deltas
// (`expected_vs_actual_revenue_delta`) and not a categorical verdict, so this
// route applies the canonical rule here:
//
//   - revenue_actual missing            → no_followup_data
//   - |delta_pct| <= 0.10               → hit          (within 10% of expectation)
//   - delta > 0  (overperformed)        → hit for increase_*, false_positive for reduce_*
//   - delta < 0  (underperformed)       → false_positive for increase_*, hit for reduce_*
//   - monitor/other actions             → no_followup_data (cannot evaluate)
//
// `recommended_campaign_worsened_d7` is true when the actual revenue is
// strictly below the expectation (i.e. delta < 0) — this lines up with the
// Python module's `worsened_recommended_rows` semantics for actionable rows.

import { Hono } from 'hono'
import type { Env } from '@/index'
import {
  summarizeBacktest,
  outcomeCounts,
  type BacktestRow,
} from '@/models/backtesting'
import { requireSession } from '@/http/middleware'
import { mapRows } from '@/db/rowMapper'

export const backtestRouter = new Hono<{ Bindings: Env }>()
backtestRouter.use('*', requireSession)

interface RawJoinRow {
  recommendation_id: string
  recommended_action: string
  business_constraints_status: string
  expected_incremental_revenue_brl: number | null
  observed_revenue_brl: number | null
  window: string | null
}

/**
 * GET /api/backtest?account_id=...&limit=500
 *
 * Returns `{ summary, counts }` with the same shape produced by the Python
 * `summarize_backtest` / `outcome_counts` helpers.
 */
backtestRouter.get('/', async (c) => {
  const accountId = c.req.query('account_id')
  const limitRaw = c.req.query('limit')
  const limit = Math.max(1, Math.min(1000, Number(limitRaw ?? 500)))

  // Per-recommendation, pick the best follow-up outcome window via a
  // correlated subquery (72h preferred, 24h next, 7d last). `window` is a
  // reserved-ish identifier so we keep the SQL grammatical without quoting —
  // SQLite happily parses bare `window` as a column name in this context.
  const baseSql = `
    SELECT
      r.recommendation_id,
      r.recommended_action,
      r.guardrail_status         AS business_constraints_status,
      r.expected_incremental_revenue_brl,
      o.observed_revenue_brl,
      o.window
    FROM recommendations r
    LEFT JOIN execution_outcomes o
      ON o.recommendation_id = r.recommendation_id
     AND o.window = (
       SELECT window FROM execution_outcomes
        WHERE recommendation_id = r.recommendation_id
        ORDER BY (CASE window
                    WHEN '72h' THEN 1
                    WHEN '24h' THEN 2
                    WHEN '7d'  THEN 3
                    ELSE 4
                  END) ASC
        LIMIT 1
     )
  `
  const sql = accountId
    ? `${baseSql} WHERE r.account_id = ? ORDER BY r.created_at DESC LIMIT ?`
    : `${baseSql} ORDER BY r.created_at DESC LIMIT ?`
  const params = accountId ? [accountId, limit] : [limit]
  const { columns, rows } = await c.env.DB.query(sql, params)

  // mapRows handles both array-form (local dev) and object-form (live Worker)
  // row shapes — see src/db/rowMapper.ts.
  const rawRows: RawJoinRow[] = mapRows<RawJoinRow>(columns, rows)

  const backtestRows: BacktestRow[] = rawRows.map((r) => {
    const outcome = classifyOutcome(
      r.observed_revenue_brl,
      r.expected_incremental_revenue_brl,
      r.recommended_action,
    )
    const gap =
      r.observed_revenue_brl !== null && r.expected_incremental_revenue_brl !== null
        ? r.observed_revenue_brl - r.expected_incremental_revenue_brl
        : null
    const worsened =
      gap !== null && gap < 0 // underperformed → "worsened" relative to expectation
    return {
      recommended_action: r.recommended_action,
      business_constraints_status: r.business_constraints_status,
      backtest_outcome_d7: outcome,
      expected_vs_realized_revenue_gap_d7: gap,
      recommended_campaign_worsened_d7:
        r.observed_revenue_brl === null || r.expected_incremental_revenue_brl === null
          ? null
          : worsened,
    }
  })

  const summary = summarizeBacktest(backtestRows)
  const counts = outcomeCounts(backtestRows)

  // NaN is not valid JSON — surface it as null so the client doesn't get a
  // 500 from `JSON.stringify` (it actually emits `NaN` which most parsers
  // reject). Mirrors how the Python dashboard wraps these values.
  return c.json({
    summary: {
      ...summary,
      hit_rate: nullIfNaN(summary.hit_rate),
      false_positive_rate: nullIfNaN(summary.false_positive_rate),
      false_negative_rate: nullIfNaN(summary.false_negative_rate),
      avg_expected_vs_realized_revenue_gap: nullIfNaN(
        summary.avg_expected_vs_realized_revenue_gap,
      ),
    },
    counts,
  })
})

function nullIfNaN(n: number): number | null {
  return Number.isFinite(n) ? n : null
}

function classifyOutcome(
  observedRevenue: number | null,
  expectedRevenue: number | null,
  action: string,
): string {
  if (observedRevenue === null || expectedRevenue === null) return 'no_followup_data'

  const isIncrease = action.startsWith('increase_')
  const isReduce = action.startsWith('reduce_')
  if (!isIncrease && !isReduce) return 'no_followup_data'

  // Anchor on the magnitude of expectation; if it's effectively zero, fall
  // back to comparing observed to zero so we don't divide by ~0.
  const anchor = Math.abs(expectedRevenue)
  const delta = observedRevenue - expectedRevenue
  const deltaPct = anchor > 1e-6 ? delta / anchor : delta

  if (Math.abs(deltaPct) <= 0.1) return 'hit'
  if (delta > 0) return isIncrease ? 'hit' : 'false_positive'
  // delta < 0: under-delivered
  return isIncrease ? 'false_positive' : 'hit'
}
