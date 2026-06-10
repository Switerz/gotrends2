import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { assertParity } from './harness'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { projectedCos, cosStatus } from '@/models/projectedCos'

type ExpectedRow = {
  case: string
  current_media_cost: number | null
  current_revenue: number | null
  delta_media_cost: number | null
  expected_incremental_revenue: number | null
  limit: number | null
  projected_cos: number | null
  status: string
}

describe('parity: projectedCos', () => {
  it('matches Python projected_cos.py for all 6 unit cases (tol 1e-6)', () => {
    const csvPath = resolve(__dirname, '../fixtures/parity/expected_projected_cos.csv')
    const raw = readCsv<Record<string, string>>(csvPath)
    const expected = coerceNumeric(raw, [
      'current_media_cost',
      'current_revenue',
      'delta_media_cost',
      'expected_incremental_revenue',
      'limit',
      'projected_cos',
    ]) as unknown as ExpectedRow[]

    const actual = expected.map(row => {
      const value = projectedCos(
        row.current_media_cost,
        row.current_revenue,
        row.delta_media_cost,
        row.expected_incremental_revenue,
      )
      const status = cosStatus(value, row.limit ?? undefined)
      return {
        case: row.case,
        current_media_cost: row.current_media_cost,
        current_revenue: row.current_revenue,
        delta_media_cost: row.delta_media_cost,
        expected_incremental_revenue: row.expected_incremental_revenue,
        limit: row.limit,
        projected_cos: value,
        status,
      }
    })

    assertParity(actual, expected, { keyCols: ['case'], tolerance: 1e-6 })
  })
})
