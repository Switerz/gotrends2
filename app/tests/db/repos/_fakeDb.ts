// tests/db/repos/_fakeDb.ts
//
// Minimal in-memory SQL "engine" used by repo round-trip tests. It is NOT a
// real SQLite — it implements only the exact INSERT / UPDATE / SELECT shapes
// the repos in `src/db/repos/` produce. Adding new patterns? Extend below.

import type { GodeployDB } from '@/db/bootstrap'

type Row = Record<string, unknown>

interface FakeDb extends GodeployDB {
  tables: Map<string, Row[]>
}

/** Strip SQL comments and collapse whitespace so regexes can be written naturally. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** Substitute SQLite-side literals the repos embed into UPDATE statements. */
function evalLiteral(literal: string): unknown {
  const trimmed = literal.trim()
  if (/^datetime\('now'\)$/i.test(trimmed)) {
    return new Date().toISOString().replace('T', ' ').replace(/\..*$/, '')
  }
  // Fallback: return as-is. Tests should never hit this path.
  return trimmed
}

export function makeFakeDb(): FakeDb {
  const tables = new Map<string, Row[]>()
  const ensure = (t: string): Row[] => {
    let arr = tables.get(t)
    if (!arr) {
      arr = []
      tables.set(t, arr)
    }
    return arr
  }

  async function exec(
    rawSql: string,
    params: unknown[] = [],
  ): Promise<{ rowsWritten: number }> {
    const sql = normalise(rawSql)

    // ----- ALTER TABLE ... ADD COLUMN ... (no-op in fakeDb) -----
    // Real SQLite enforces the column structure; the fake stores rows as
    // loose objects so adding a column is a no-op. Without this branch the
    // bootstrap migration array would explode on every test.
    if (/^ALTER\s+TABLE\b/i.test(sql)) {
      return { rowsWritten: 0 }
    }

    // ----- INSERT -----
    const insertMatch = sql.match(
      /^INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)$/i,
    )
    if (insertMatch) {
      const [, table, colsRaw] = insertMatch
      const cols = colsRaw!.split(',').map((c) => c.trim())
      const row: Row = {}
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]!] = params[i] ?? null
      }
      // Default timestamps used by the schema's `DEFAULT (datetime('now'))`.
      const now = new Date().toISOString().replace('T', ' ').replace(/\..*$/, '')
      const defaults: Record<string, string> = {
        created_at: now,
        updated_at: now,
        run_ts: now,
        decided_at: now,
        observed_at: now,
      }
      for (const [k, v] of Object.entries(defaults)) {
        if (!(k in row)) row[k] = v
      }
      ensure(table!).push(row)
      return { rowsWritten: 1 }
    }

    // ----- UPDATE -----
    // Supports: UPDATE <t> SET col=?, col=<literal>, ... WHERE col = ?
    const updateMatch = sql.match(
      /^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(\w+)\s*=\s*\?$/i,
    )
    if (updateMatch) {
      const [, table, assignmentsRaw, whereCol] = updateMatch
      const assignments = assignmentsRaw!.split(',').map((a) => a.trim())
      const setOps: Array<{ col: string; value: unknown }> = []
      let paramIdx = 0
      for (const a of assignments) {
        const m = a.match(/^(\w+)\s*=\s*(.+)$/)
        if (!m) continue
        const col = m[1]!
        const rhs = m[2]!.trim()
        if (rhs === '?') {
          setOps.push({ col, value: params[paramIdx++] })
        } else {
          setOps.push({ col, value: evalLiteral(rhs) })
        }
      }
      const whereVal = params[paramIdx]
      const rows = ensure(table!)
      let written = 0
      for (const row of rows) {
        if (row[whereCol!] === whereVal) {
          for (const op of setOps) row[op.col] = op.value
          written++
        }
      }
      return { rowsWritten: written }
    }

    throw new Error(`fakeDb.exec: unsupported SQL: ${sql}`)
  }

  async function query(
    rawSql: string,
    params: unknown[] = [],
  ): Promise<{ columns: string[]; rows: unknown[][]; rowsRead: number }> {
    const sql = normalise(rawSql)

    // SELECT * FROM <t> [WHERE col = ? [AND col = ?]] [ORDER BY col [DESC]] [LIMIT ?|<int>]
    const selectMatch = sql.match(
      /^SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\?|\d+))?$/i,
    )
    if (!selectMatch) {
      throw new Error(`fakeDb.query: unsupported SQL: ${sql}`)
    }
    const [, table, whereRaw, orderCol, orderDir, limitTok] = selectMatch
    let rows = ensure(table!).slice()
    let paramIdx = 0

    if (whereRaw) {
      const clauses = whereRaw.split(/\s+AND\s+/i).map((c) => c.trim())
      const filters: Array<{ col: string; value: unknown }> = []
      for (const c of clauses) {
        const m = c.match(/^(\w+)\s*=\s*\?$/)
        if (!m) throw new Error(`fakeDb.query: unsupported WHERE clause: ${c}`)
        filters.push({ col: m[1]!, value: params[paramIdx++] })
      }
      rows = rows.filter((r) =>
        filters.every((f) => r[f.col] === f.value),
      )
    }

    if (orderCol) {
      const dir = (orderDir ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1
      rows.sort((a, b) => {
        const av = a[orderCol]
        const bv = b[orderCol]
        if (av === bv) return 0
        if (av === null || av === undefined) return 1 * dir
        if (bv === null || bv === undefined) return -1 * dir
        if (av! < bv!) return -1 * dir
        if (av! > bv!) return 1 * dir
        return 0
      })
    }

    if (limitTok) {
      let limitVal: unknown
      if (limitTok === '?') {
        limitVal = params[paramIdx++]
      } else {
        limitVal = Number(limitTok)
      }
      if (typeof limitVal === 'number' && Number.isFinite(limitVal)) {
        rows = rows.slice(0, limitVal)
      }
    }

    // Collect a stable column ordering: union of keys across remaining rows.
    const colSet = new Set<string>()
    const allRows = ensure(table!)
    for (const r of allRows) for (const k of Object.keys(r)) colSet.add(k)
    const columns = Array.from(colSet)
    const tuples = rows.map((r) => columns.map((c) => r[c] ?? null))
    return { columns, rows: tuples, rowsRead: tuples.length }
  }

  return { tables, exec, query }
}
