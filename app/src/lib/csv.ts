import { parse } from 'csv-parse/sync'
import { readFileSync } from 'node:fs'

export function readCsv<T = Record<string, string>>(path: string): T[] {
  const content = readFileSync(path, 'utf8')
  return parse(content, { columns: true, skip_empty_lines: true }) as T[]
}

export function coerceNumeric<T extends Record<string, unknown>>(rows: T[], cols: string[]): T[] {
  return rows.map(r => {
    const out: Record<string, unknown> = { ...r }
    for (const c of cols) {
      const v = r[c]
      if (v === '' || v === undefined || v === null) { out[c] = null; continue }
      const n = Number(v)
      out[c] = Number.isFinite(n) ? n : null
    }
    return out as T
  })
}
