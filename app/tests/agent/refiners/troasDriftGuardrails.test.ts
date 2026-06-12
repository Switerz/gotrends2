// tests/agent/refiners/troasDriftGuardrails.test.ts
//
// Soft-cap guardrails that consider cumulative tROAS drift over a window.
// Covers both the daily (40%) and 7d rolling (30%) caps end-to-end via
// refine() so the verdict-merge logic is exercised too.

import { describe, it, expect } from 'vitest'
import { refine, type RefineContext } from '@/agent/refiners/refine'
import type { Candidate } from '@/agent/refiners/schema'
import type { TroasDrift } from '@/agent/refiners/troasDrift'

const TROAS_CANDIDATE: Candidate = {
  account_id: '7705857660',
  campaign_id: 'camp-1',
  campaign_name: 'Search NB',
  skill_type: 'budget_reallocation',
  recommended_action: 'increase_troas_or_reduce_budget',
  change_percent: 0.10, // +10% — well inside per-rec hard limit (50%)
  current_budget_brl: 1000,
  current_target_roas: 5.0,
  expected_marginal_roas: 3.5,
  confidence_score: 80,
  risk_level: 'low',
  reason: null,
}

const CTX_BASE: RefineContext = {
  runId: '00000000-0000-4000-8000-000000000000',
  recommendationId: '00000000-0000-4000-8000-000000000001',
}

describe('refine — tROAS soft caps', () => {
  it('verdict stays ok when cumulative drift + proposed stays under both caps', () => {
    const drift: TroasDrift = { todayDriftPct: 0.10, sevenDayDriftPct: 0.15 }
    const r = refine(TROAS_CANDIDATE, { ...CTX_BASE, troasDrift: drift })
    // proposed = +10%; today=10+10=20% < 40%; 7d=15+10=25% < 30%
    expect(r.guardrail_status).toBe('ok')
    expect(r.guardrail_reason).toBeNull()
  })

  it('verdict stays ok exactly at the 7d cap (boundary is inclusive)', () => {
    const drift: TroasDrift = { todayDriftPct: 0, sevenDayDriftPct: 0.20 }
    const r = refine(TROAS_CANDIDATE, { ...CTX_BASE, troasDrift: drift })
    // 20 + 10 = 30 — exactly the 7d cap; rule uses `>` so this passes.
    expect(r.guardrail_status).toBe('ok')
  })

  it('downgrades to needs_human_review when daily cap is exceeded', () => {
    const drift: TroasDrift = { todayDriftPct: 0.35, sevenDayDriftPct: 0.35 }
    const r = refine(TROAS_CANDIDATE, { ...CTX_BASE, troasDrift: drift })
    // today = 35+10 = 45% > 40% → trip daily
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toMatch(/daily_troas_cap/)
    // Reason carries the consumed-vs-cap figures for ops visibility
    expect(r.guardrail_reason).toMatch(/35%/)
    expect(r.guardrail_reason).toMatch(/40%/)
  })

  it('downgrades to needs_human_review when 7d cap is exceeded (daily still ok)', () => {
    const drift: TroasDrift = { todayDriftPct: 0.05, sevenDayDriftPct: 0.25 }
    const r = refine(TROAS_CANDIDATE, { ...CTX_BASE, troasDrift: drift })
    // today = 5+10 = 15% (ok); 7d = 25+10 = 35% > 30% → trip 7d
    expect(r.guardrail_status).toBe('needs_human_review')
    expect(r.guardrail_reason).toMatch(/rolling_7d_troas_cap/)
  })

  it('daily reason takes priority when both caps are tripped', () => {
    const drift: TroasDrift = { todayDriftPct: 0.40, sevenDayDriftPct: 0.40 }
    const r = refine(TROAS_CANDIDATE, { ...CTX_BASE, troasDrift: drift })
    expect(r.guardrail_status).toBe('needs_human_review')
    // Daily is the operator-actionable one (7d cools off mechanically).
    expect(r.guardrail_reason).toMatch(/daily_troas_cap/)
  })

  it('hard block from the base guardrail (change_percent > 50%) wins over the soft cap', () => {
    const drift: TroasDrift = { todayDriftPct: 0.50, sevenDayDriftPct: 0.50 }
    const r = refine(
      { ...TROAS_CANDIDATE, change_percent: 0.60 }, // hard-block territory
      { ...CTX_BASE, troasDrift: drift },
    )
    expect(r.guardrail_status).toBe('blocked')
    expect(r.guardrail_reason).toMatch(/change_above_50pct_hard_limit/)
  })

  it('does NOT apply soft caps to non-tROAS actions (e.g. increase_budget)', () => {
    const drift: TroasDrift = { todayDriftPct: 0.50, sevenDayDriftPct: 0.50 }
    const r = refine(
      { ...TROAS_CANDIDATE, recommended_action: 'increase_budget' },
      { ...CTX_BASE, troasDrift: drift },
    )
    // Budget actions don't trip tROAS caps — by design, per Google Ads
    // specialist guidance: budget is passive, bid is the active signal.
    expect(r.guardrail_status).toBe('ok')
    expect(r.guardrail_reason).toBeNull()
  })

  it('skips the soft caps entirely when no drift snapshot is supplied', () => {
    const r = refine(TROAS_CANDIDATE, CTX_BASE) // no troasDrift
    expect(r.guardrail_status).toBe('ok')
  })

  it('skips the soft caps when current_target_roas is null (no baseline to compute %)', () => {
    const drift: TroasDrift = { todayDriftPct: 0.50, sevenDayDriftPct: 0.50 }
    const r = refine(
      { ...TROAS_CANDIDATE, current_target_roas: null },
      { ...CTX_BASE, troasDrift: drift },
    )
    expect(r.guardrail_status).toBe('ok')
  })
})
