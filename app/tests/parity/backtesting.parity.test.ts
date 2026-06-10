// tests/parity/backtesting.parity.test.ts
//
// Parity test: TS `summarizeBacktest` and `outcomeCounts` must match the
// Python reference outputs (asdict of the BacktestSummary dataclass and the
// Counter.most_common() list) within 1e-6.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { summarizeBacktest, outcomeCounts, type BacktestRow } from '@/models/backtesting'

const FIX = resolve(__dirname, '../fixtures/parity')

function loadInput(): BacktestRow[] {
  const inputRaw = coerceNumeric(
    readCsv<Record<string, string>>(`${FIX}/input_backtest_decision_log.csv`),
    ['expected_vs_realized_revenue_gap_d7'],
  ) as Array<Record<string, unknown>>
  // pandas writes booleans as "True" / "False"; the CSV does not encode
  // pandas' nullable NA, but our null-on-empty rule below covers any blanks.
  return inputRaw.map((r) => ({
    recommended_action: String(r['recommended_action']),
    business_constraints_status: String(r['business_constraints_status']),
    backtest_outcome_d7:
      r['backtest_outcome_d7'] === '' || r['backtest_outcome_d7'] == null
        ? null
        : String(r['backtest_outcome_d7']),
    expected_vs_realized_revenue_gap_d7:
      (r['expected_vs_realized_revenue_gap_d7'] as number | null) ?? null,
    recommended_campaign_worsened_d7:
      r['recommended_campaign_worsened_d7'] === 'True'
        ? true
        : r['recommended_campaign_worsened_d7'] === 'False'
          ? false
          : null,
  }))
}

describe('parity: backtesting', () => {
  it('summarizeBacktest matches Python expected_backtest_summary.json within 1e-6', () => {
    const input = loadInput()
    const expected = JSON.parse(
      readFileSync(`${FIX}/expected_backtest_summary.json`, 'utf8'),
    )
    const actual = summarizeBacktest(input)

    expect(actual.rows).toBe(expected.rows)
    expect(actual.evaluated_rows).toBe(expected.evaluated_rows)
    expect(actual.candidate_rows).toBe(expected.candidate_rows)
    expect(actual.worsened_recommended_rows).toBe(expected.worsened_recommended_rows)
    expect(actual.hit_rate).toBeCloseTo(expected.hit_rate, 6)
    expect(actual.false_positive_rate).toBeCloseTo(expected.false_positive_rate, 6)
    expect(actual.false_negative_rate).toBeCloseTo(expected.false_negative_rate, 6)
    if (Number.isFinite(expected.avg_expected_vs_realized_revenue_gap)) {
      expect(actual.avg_expected_vs_realized_revenue_gap).toBeCloseTo(
        expected.avg_expected_vs_realized_revenue_gap,
        6,
      )
    } else {
      expect(Number.isFinite(actual.avg_expected_vs_realized_revenue_gap)).toBe(false)
    }
  })

  it('outcomeCounts matches Python output (count-grouping, order-insensitive within count tie)', () => {
    const input = loadInput()
    const expected = JSON.parse(
      readFileSync(`${FIX}/expected_backtest_outcome_counts.json`, 'utf8'),
    ) as Array<{
      recommended_action: string
      business_constraints_status: string
      backtest_outcome_d7: string | null
      rows: number
    }>
    const actual = outcomeCounts(input)

    expect(actual.length).toBe(expected.length)

    // Python `Counter.most_common()` orders by descending count, and within a
    // tie the iteration order is implementation-defined (insertion order on
    // CPython 3.7+, but the synthetic input is deliberately not stable enough
    // to rely on that). Compare via a count-grouped signature.
    const sortKey = (o: {
      recommended_action: string
      business_constraints_status: string
      backtest_outcome_d7: string | null
      rows: number
    }): string =>
      `${o.rows.toString().padStart(4, '0')}|${o.recommended_action}|${o.business_constraints_status}|${o.backtest_outcome_d7 ?? ''}`

    const actualSorted = [...actual].sort((a, b) =>
      sortKey(a).localeCompare(sortKey(b)),
    )
    const expectedSorted = [...expected].sort((a, b) =>
      sortKey(a).localeCompare(sortKey(b)),
    )
    expect(actualSorted).toEqual(expectedSorted)

    // Also assert the top-level count ordering (descending) is preserved.
    for (let i = 1; i < actual.length; i++) {
      expect(actual[i]!.rows).toBeLessThanOrEqual(actual[i - 1]!.rows)
    }
  })
})
