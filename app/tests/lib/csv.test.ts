import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'

describe('csv', () => {
  it('readCsv parses header + rows into objects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gotrends-csv-'))
    const p = join(dir, 'sample.csv')
    writeFileSync(p, 'a,b\n1,foo\n2,bar\n')
    const rows = readCsv<{ a: string; b: string }>(p)
    expect(rows).toEqual([
      { a: '1', b: 'foo' },
      { a: '2', b: 'bar' },
    ])
  })

  it('coerceNumeric converts listed columns to number, empty/null -> null', () => {
    const rows = [
      { a: '1.5', b: 'x' },
      { a: '', b: 'y' },
      { a: 'NaN', b: 'z' },
    ]
    const out = coerceNumeric(rows, ['a'])
    expect(out[0]!.a).toBe(1.5)
    expect(out[0]!.b).toBe('x') // untouched
    expect(out[1]!.a).toBeNull()
    expect(out[2]!.a).toBeNull() // 'NaN' string -> NaN -> not finite -> null
  })
})
