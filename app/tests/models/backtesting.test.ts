// tests/models/backtesting.test.ts
//
// Edge-case coverage for the backtesting aggregation TS port. The parity
// test in tests/parity/backtesting.parity.test.ts covers the happy path
// against the Python reference; this file exercises empty / all-skipped /
// boundary cases that the synthetic decision log doesn't reach.

import { describe, it, expect } from 'vitest'
import {
  summarizeBacktest,
  outcomeCounts,
  dashboardMetrics,
  decisionLogColumns,
  validateBacktestRows,
  type BacktestRow,
} from '@/models/backtesting'

function makeRow(over: Partial<BacktestRow> = {}): BacktestRow {
  return {
    recommended_action: 'increase_budget',
    business_constraints_status: 'ok',
    backtest_outcome_d7: 'hit',
    expected_vs_realized_revenue_gap_d7: 0,
    recommended_campaign_worsened_d7: false,
    ...over,
  }
}

describe('backtesting model', () => {
  it('summarizeBacktest on empty input → 0 rows, NaN rates', () => {
    const s = summarizeBacktest([])
    expect(s.rows).toBe(0)
    expect(s.evaluated_rows).toBe(0)
    expect(s.candidate_rows).toBe(0)
    expect(s.worsened_recommended_rows).toBe(0)
    expect(Number.isNaN(s.hit_rate)).toBe(true)
    expect(Number.isNaN(s.false_positive_rate)).toBe(true)
    expect(Number.isNaN(s.false_negative_rate)).toBe(true)
    expect(Number.isNaN(s.avg_expected_vs_realized_revenue_gap)).toBe(true)
  })

  it('all no_followup_data → evaluated_rows=0, all rates NaN', () => {
    const rows = [
      makeRow({ backtest_outcome_d7: 'no_followup_data' }),
      makeRow({ backtest_outcome_d7: 'no_followup_data', recommended_action: 'monitor' }),
      makeRow({ backtest_outcome_d7: 'no_followup_data', business_constraints_status: 'blocked' }),
    ]
    const s = summarizeBacktest(rows)
    expect(s.rows).toBe(3)
    expect(s.evaluated_rows).toBe(0)
    expect(s.candidate_rows).toBe(0)
    expect(Number.isNaN(s.hit_rate)).toBe(true)
    expect(Number.isNaN(s.false_positive_rate)).toBe(true)
    expect(Number.isNaN(s.false_negative_rate)).toBe(true)
    expect(Number.isNaN(s.avg_expected_vs_realized_revenue_gap)).toBe(true)
  })

  it('all monitor actions → candidate_rows=0, hit_rate NaN, false_negative_rate computed', () => {
    const rows = [
      makeRow({ recommended_action: 'monitor', backtest_outcome_d7: 'false_negative' }),
      makeRow({ recommended_action: 'monitor', backtest_outcome_d7: 'false_negative' }),
      makeRow({ recommended_action: 'monitor', backtest_outcome_d7: 'hit' }),
      makeRow({ recommended_action: 'monitor', backtest_outcome_d7: 'no_followup_data' }),
    ]
    const s = summarizeBacktest(rows)
    expect(s.rows).toBe(4)
    expect(s.evaluated_rows).toBe(3)
    expect(s.candidate_rows).toBe(0)
    expect(Number.isNaN(s.hit_rate)).toBe(true)
    expect(Number.isNaN(s.false_positive_rate)).toBe(true)
    expect(Number.isNaN(s.avg_expected_vs_realized_revenue_gap)).toBe(true)
    // 2 of the 3 evaluated monitor rows are false_negative → 2/3
    expect(s.false_negative_rate).toBeCloseTo(2 / 3, 6)
  })

  it('all blocked constraints → candidate_rows=0', () => {
    const rows = [
      makeRow({ business_constraints_status: 'blocked', backtest_outcome_d7: 'hit' }),
      makeRow({ business_constraints_status: 'blocked', backtest_outcome_d7: 'false_positive' }),
    ]
    const s = summarizeBacktest(rows)
    expect(s.rows).toBe(2)
    expect(s.evaluated_rows).toBe(2)
    expect(s.candidate_rows).toBe(0)
    expect(s.worsened_recommended_rows).toBe(0)
    expect(Number.isNaN(s.hit_rate)).toBe(true)
  })

  it('worsened flag counted only among actionable rows', () => {
    const rows = [
      makeRow({ recommended_campaign_worsened_d7: true }),
      makeRow({ recommended_campaign_worsened_d7: true }),
      makeRow({ recommended_campaign_worsened_d7: false }),
      makeRow({ recommended_campaign_worsened_d7: null }),
      // Monitor + worsened — must NOT count (not actionable).
      makeRow({ recommended_action: 'monitor', recommended_campaign_worsened_d7: true }),
      // Blocked + worsened — must NOT count (not actionable).
      makeRow({ business_constraints_status: 'blocked', recommended_campaign_worsened_d7: true }),
    ]
    const s = summarizeBacktest(rows)
    expect(s.candidate_rows).toBe(4) // 4 actionable
    expect(s.worsened_recommended_rows).toBe(2) // first 2 rows
  })

  it('validateBacktestRows throws when a required column is missing', () => {
    expect(() =>
      validateBacktestRows([
        {
          recommended_action: 'increase_budget',
          business_constraints_status: 'ok',
          // missing backtest_outcome_d7
          expected_vs_realized_revenue_gap_d7: 0,
          recommended_campaign_worsened_d7: false,
        },
      ]),
    ).toThrow(/Missing backtest columns: backtest_outcome_d7/)

    // Empty input is a no-op
    expect(() => validateBacktestRows([])).not.toThrow()
  })

  it('outcomeCounts groups by (action, status, outcome) and orders by count desc', () => {
    const rows = [
      makeRow({ recommended_action: 'increase_budget', backtest_outcome_d7: 'hit' }),
      makeRow({ recommended_action: 'increase_budget', backtest_outcome_d7: 'hit' }),
      makeRow({ recommended_action: 'increase_budget', backtest_outcome_d7: 'hit' }),
      makeRow({ recommended_action: 'reduce_budget', backtest_outcome_d7: 'false_positive' }),
      makeRow({ recommended_action: 'reduce_budget', backtest_outcome_d7: 'false_positive' }),
      makeRow({ recommended_action: 'monitor', backtest_outcome_d7: 'false_negative' }),
    ]
    const counts = outcomeCounts(rows)
    expect(counts).toEqual([
      {
        recommended_action: 'increase_budget',
        business_constraints_status: 'ok',
        backtest_outcome_d7: 'hit',
        rows: 3,
      },
      {
        recommended_action: 'reduce_budget',
        business_constraints_status: 'ok',
        backtest_outcome_d7: 'false_positive',
        rows: 2,
      },
      {
        recommended_action: 'monitor',
        business_constraints_status: 'ok',
        backtest_outcome_d7: 'false_negative',
        rows: 1,
      },
    ])
  })

  it('decisionLogColumns returns the canonical 13 strings', () => {
    const cols = decisionLogColumns()
    expect(cols).toHaveLength(13)
    expect(cols[0]).toBe('decision_date')
    expect(cols[cols.length - 1]).toBe('created_at')
    expect(cols.every((c) => typeof c === 'string')).toBe(true)
    // No duplicates.
    expect(new Set(cols).size).toBe(cols.length)
  })

  it('dashboardMetrics returns the same shape as summarizeBacktest', () => {
    const rows = [makeRow(), makeRow({ backtest_outcome_d7: 'false_positive' })]
    const a = dashboardMetrics(rows)
    const b = summarizeBacktest(rows)
    expect(a).toEqual(b)
  })
})
