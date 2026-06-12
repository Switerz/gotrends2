// src/agent/refiners/troasDrift.ts
//
// DB-backed lookup of cumulative tROAS drift for a campaign. Used by the
// refiner to apply the daily / rolling-7d cumulative caps without having to
// thread DB access through every guardrail.
//
// Two queries (today + 7d) over `executions` JOIN `recommendations`, summing
// |Δ tROAS / pre_mutate_tROAS| for successful tROAS mutates. A rec that has
// been approved but not yet executed does NOT count — caps are about what was
// actually applied to the campaign.

import type { GodeployDB } from '@/db/bootstrap'

export interface TroasDrift {
  /** Sum of |Δ tROAS_i / pre_mutate_tROAS_i| for successful tROAS mutates today (UTC). */
  todayDriftPct: number
  /** Same shape, rolling 7-day window. Always ≥ todayDriftPct. */
  sevenDayDriftPct: number
}

const ZERO_DRIFT: TroasDrift = { todayDriftPct: 0, sevenDayDriftPct: 0 }

/**
 * Compute cumulative tROAS drift for `campaignId` ending at `nowIso`.
 * Returns {0,0} for any campaign that has had no successful tROAS mutate in
 * the last 7 days — including any DB error, which is logged but never
 * propagated (a drift query failure must not block recommendation generation).
 */
export async function computeTroasDrift(
  db: GodeployDB,
  campaignId: string,
  nowIso: string,
): Promise<TroasDrift> {
  if (!campaignId) return ZERO_DRIFT

  // Today is defined as "since midnight UTC". Aligns with the cron schedule
  // (06:00 UTC run-models) and keeps the boundary deterministic across
  // operators in different timezones.
  const todayStart = nowIso.slice(0, 10) + 'T00:00:00.000Z'
  const sevenDayStart = new Date(
    new Date(nowIso).getTime() - 7 * 24 * 3600 * 1000,
  ).toISOString()

  // One query, parameterised by lower bound. SQLite's COALESCE + NULLIF guards
  // against division-by-zero when current_target_roas is 0 (shouldn't happen
  // — guardrail's domain — but defensive).
  const sql = `
    SELECT COALESCE(SUM(ABS(
      (r.proposed_target_roas - r.current_target_roas) /
      NULLIF(r.current_target_roas, 0)
    )), 0) AS pct
    FROM executions e
    JOIN recommendations r ON r.recommendation_id = e.recommendation_id
    WHERE r.campaign_id = ?
      AND e.status = 'success'
      AND r.recommended_action = 'increase_troas_or_reduce_budget'
      AND r.current_target_roas IS NOT NULL
      AND r.proposed_target_roas IS NOT NULL
      AND e.completed_at >= ?
  `

  try {
    const [today, sevenDay] = await Promise.all([
      db.query(sql, [campaignId, todayStart]),
      db.query(sql, [campaignId, sevenDayStart]),
    ])
    return {
      todayDriftPct: extractPct(today),
      sevenDayDriftPct: extractPct(sevenDay),
    }
  } catch (e) {
    console.log(
      JSON.stringify({
        event: 'troas_drift_query_failed',
        campaignId,
        error: (e as Error).message,
      }),
    )
    return ZERO_DRIFT
  }
}

/** Extract the `pct` column from a 1-row result, tolerating both row shapes. */
function extractPct(r: { columns: string[]; rows: unknown[] }): number {
  if (r.rows.length === 0) return 0
  const row = r.rows[0]
  if (Array.isArray(row)) {
    const v = (row as unknown[])[0]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  const obj = row as Record<string, unknown>
  const v = obj['pct']
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
