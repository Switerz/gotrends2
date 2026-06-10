import { describe, it, expect } from 'vitest'
import { assertParity } from './harness'
import { ParityViolation } from '@/core/errors'

describe('parity harness', () => {
  it('passes when float fields are within tolerance', () => {
    expect(() =>
      assertParity(
        [{ id: '1', roas: 2.500001 }],
        [{ id: '1', roas: 2.5 }],
        { keyCols: ['id'], tolerance: 1e-5 },
      ),
    ).not.toThrow()
  })

  it('fails when float fields differ beyond tolerance', () => {
    expect(() =>
      assertParity(
        [{ id: '1', roas: 2.6 }],
        [{ id: '1', roas: 2.5 }],
        { keyCols: ['id'], tolerance: 1e-6 },
      ),
    ).toThrow(ParityViolation)
  })

  it('compares string fields exactly', () => {
    expect(() =>
      assertParity(
        [{ id: '1', status: 'positive' }],
        [{ id: '1', status: 'negative' }],
        { keyCols: ['id'] },
      ),
    ).toThrow(/status/)
  })

  it('row count mismatch raises ParityViolation', () => {
    expect(() =>
      assertParity(
        [{ id: '1' }, { id: '2' }],
        [{ id: '1' }],
        { keyCols: ['id'] },
      ),
    ).toThrow(/__row_count__/)
  })

  it('missing expected row raises ParityViolation', () => {
    expect(() =>
      assertParity(
        [{ id: '99' }],
        [{ id: '1' }],
        { keyCols: ['id'] },
      ),
    ).toThrow(/__missing_row__|expected row not found/)
  })

  it('null/empty-string parity holds', () => {
    expect(() =>
      assertParity(
        [{ id: '1', x: null }],
        [{ id: '1', x: '' }],
        { keyCols: ['id'] },
      ),
    ).not.toThrow()
    expect(() =>
      assertParity(
        [{ id: '1', x: NaN }],
        [{ id: '1', x: null }],
        { keyCols: ['id'] },
      ),
    ).not.toThrow()
  })

  it('ignore list skips a column', () => {
    expect(() =>
      assertParity(
        [{ id: '1', noise: 'A', signal: 5 }],
        [{ id: '1', noise: 'B', signal: 5 }],
        { keyCols: ['id'], ignore: ['noise'] },
      ),
    ).not.toThrow()
  })

  it('compares against expected: number when actual is string-numeric (coercion)', () => {
    // simulates loading CSV without coerceNumeric on the actual side
    expect(() =>
      assertParity(
        [{ id: '1', roas: '2.5000005' }] as any,
        [{ id: '1', roas: 2.5 }],
        { keyCols: ['id'], tolerance: 1e-5 },
      ),
    ).not.toThrow()
  })
})
