// src/db/rowMapper.ts
//
// Tiny helpers used by every repo to convert query results into typed objects
// keyed by column name.
//
// The Godeploy `env.DB.query()` binding returns rows in TWO different shapes
// depending on the runtime:
//   - Array form `[v0, v1, v2]` — used by the local dev adapter (better-sqlite3
//     converts each SQLite row to a tuple keyed by column index).
//   - Object form `{ col0: v0, col1: v1 }` — used by the live Godeploy Worker
//     runtime, which returns each row as an object keyed by column name.
//
// The mismatch caused every prod DB read to return objects with undefined
// values (numeric indexing on an object yields undefined for non-numeric
// keys). We now handle both shapes here so callers never need to care.
//
// The `columns` array is authoritative for which fields to copy.

export function mapRow<T>(columns: string[], values: unknown): T {
  if (Array.isArray(values)) {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < columns.length; i++) {
      out[columns[i]!] = values[i]
    }
    return out as T
  }
  if (values && typeof values === 'object') {
    const obj = values as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const c of columns) {
      out[c] = obj[c]
    }
    return out as T
  }
  // Fallback: returns an object with undefined values — caller will get a
  // clean (but useless) row, not a crash.
  const out: Record<string, unknown> = {}
  for (const c of columns) out[c] = undefined
  return out as T
}

export function mapRows<T>(columns: string[], rows: unknown[]): T[] {
  return rows.map((r) => mapRow<T>(columns, r))
}
