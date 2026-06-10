// src/db/rowMapper.ts
//
// Tiny helpers used by every repo to convert tuple-shaped query results
// (`{ columns: string[]; rows: unknown[][] }` from the Godeploy DB binding)
// into typed objects keyed by column name.

export function mapRow<T>(columns: string[], values: unknown[]): T {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < columns.length; i++) {
    out[columns[i]!] = values[i]
  }
  return out as T
}

export function mapRows<T>(columns: string[], rows: unknown[][]): T[] {
  return rows.map((r) => mapRow<T>(columns, r))
}
