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
  // Single-quoted string literal — strip the quotes.
  if (/^'[^']*'$/.test(trimmed)) {
    return trimmed.slice(1, -1)
  }
  // Numeric literal.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
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
    // Tables that have a composite primary key the fake DB needs to honour
    // when the statement is `INSERT OR REPLACE`. SQLite uses the real PK
    // declared in DDL; the fake hardcodes them (cheap, change-cost: 1 line).
    const REPLACE_PKS: Record<string, string[]> = {
      campaign_revenue_daily: ['account_id', 'campaign_name', 'date'],
    }
    const insertMatch = sql.match(
      /^INSERT(?:\s+OR\s+(\w+))?\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)$/i,
    )
    if (insertMatch) {
      const [, orClause, table, colsRaw] = insertMatch
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
        synced_at: now,
      }
      for (const [k, v] of Object.entries(defaults)) {
        if (!(k in row)) row[k] = v
      }
      const tableRows = ensure(table!)
      // INSERT OR REPLACE: delete any row that conflicts on the known PK.
      if (
        orClause &&
        orClause.toUpperCase() === 'REPLACE' &&
        REPLACE_PKS[table!]
      ) {
        const pk = REPLACE_PKS[table!]!
        for (let i = tableRows.length - 1; i >= 0; i--) {
          const r = tableRows[i]!
          if (pk.every((k) => r[k] === row[k])) tableRows.splice(i, 1)
        }
      }
      tableRows.push(row)
      return { rowsWritten: 1 }
    }

    // ----- UPDATE -----
    // Supports compound WHERE clauses (same operator set as SELECT):
    //   col = ? | col = 'literal' | col IS [NOT] NULL | col {<,<=,>,>=} ?|literal
    //   col IN ('a','b',...)
    // Joined by AND. SET is comma-separated col=? | col=<literal>.
    const updateMatch = sql.match(
      /^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i,
    )
    if (updateMatch) {
      const [, table, assignmentsRaw, whereRaw] = updateMatch
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
      // Reuse the same WHERE clause parsing shape as SELECT.
      const clauses = whereRaw!.split(/\s+AND\s+/i).map((c) => c.trim())
      type EqF = { kind: 'eq'; col: string; value: unknown }
      type InF = { kind: 'in'; col: string; values: unknown[] }
      type NullF = { kind: 'null'; col: string; negated: boolean }
      type CmpF = { kind: 'cmp'; col: string; op: '<' | '<=' | '>' | '>='; value: unknown }
      const filters: Array<EqF | InF | NullF | CmpF> = []
      for (const c of clauses) {
        const eq = c.match(/^(\w+)\s*=\s*(\?|'[^']*')$/)
        if (eq) {
          const rhs = eq[2]!
          const v = rhs === '?' ? params[paramIdx++] : rhs.slice(1, -1)
          filters.push({ kind: 'eq', col: eq[1]!, value: v })
          continue
        }
        const nullCheck = c.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i)
        if (nullCheck) {
          filters.push({ kind: 'null', col: nullCheck[1]!, negated: Boolean(nullCheck[2]) })
          continue
        }
        const cmp = c.match(/^(\w+)\s*(<=|>=|<|>)\s*(\?|'[^']*')$/)
        if (cmp) {
          const rhs = cmp[3]!
          const v = rhs === '?' ? params[paramIdx++] : rhs.slice(1, -1)
          filters.push({ kind: 'cmp', col: cmp[1]!, op: cmp[2]! as CmpF['op'], value: v })
          continue
        }
        const inLit = c.match(/^(\w+)\s+IN\s*\(\s*(.+?)\s*\)$/i)
        if (inLit) {
          const values = inLit[2]!
            .split(',')
            .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
          filters.push({ kind: 'in', col: inLit[1]!, values })
          continue
        }
        throw new Error(`fakeDb.exec UPDATE: unsupported WHERE clause: ${c}`)
      }
      const matchRow = (row: Row): boolean =>
        filters.every((f) => {
          const cell = row[f.col]
          switch (f.kind) {
            case 'eq':
              return cell === f.value
            case 'null':
              return f.negated ? cell !== null && cell !== undefined : cell === null || cell === undefined
            case 'cmp': {
              if (cell === null || cell === undefined) return false
              const a = cell as string | number
              const b = f.value as string | number
              if (f.op === '<') return a < b
              if (f.op === '<=') return a <= b
              if (f.op === '>') return a > b
              return a >= b
            }
            case 'in':
              return f.values.includes(cell as string)
          }
        })

      const rows = ensure(table!)
      let written = 0
      for (const row of rows) {
        if (matchRow(row)) {
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
      type EqFilter = { kind: 'eq'; col: string; value: unknown }
      type InFilter = { kind: 'in'; col: string; values: unknown[] }
      type NullFilter = { kind: 'null'; col: string; negated: boolean }
      type CompareFilter = {
        kind: 'cmp'
        col: string
        op: '<' | '<=' | '>' | '>='
        value: unknown
      }
      type AnyFilter = EqFilter | InFilter | NullFilter | CompareFilter
      const filters: AnyFilter[] = []
      for (const c of clauses) {
        // `col = ?` or `col = 'literal'`
        const eq = c.match(/^(\w+)\s*=\s*(\?|'[^']*')$/)
        if (eq) {
          const rhs = eq[2]!
          const v = rhs === '?' ? params[paramIdx++] : rhs.slice(1, -1)
          filters.push({ kind: 'eq', col: eq[1]!, value: v })
          continue
        }
        // `col IS NULL` / `col IS NOT NULL`
        const nullCheck = c.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i)
        if (nullCheck) {
          filters.push({
            kind: 'null',
            col: nullCheck[1]!,
            negated: Boolean(nullCheck[2]),
          })
          continue
        }
        // `col {<,<=,>,>=} ?` or literal
        const cmp = c.match(/^(\w+)\s*(<=|>=|<|>)\s*(\?|'[^']*')$/)
        if (cmp) {
          const rhs = cmp[3]!
          const v = rhs === '?' ? params[paramIdx++] : rhs.slice(1, -1)
          filters.push({
            kind: 'cmp',
            col: cmp[1]!,
            op: cmp[2]! as CompareFilter['op'],
            value: v,
          })
          continue
        }
        // `col IN ('a', 'b', 'c')` — literals only.
        const inLit = c.match(/^(\w+)\s+IN\s*\(\s*(.+?)\s*\)$/i)
        if (inLit) {
          const values = inLit[2]!
            .split(',')
            .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
          filters.push({ kind: 'in', col: inLit[1]!, values })
          continue
        }
        throw new Error(`fakeDb.query: unsupported WHERE clause: ${c}`)
      }
      rows = rows.filter((r) =>
        filters.every((f) => {
          const cell = r[f.col]
          switch (f.kind) {
            case 'eq':
              return cell === f.value
            case 'null':
              return f.negated ? cell !== null && cell !== undefined : cell === null || cell === undefined
            case 'cmp': {
              if (cell === null || cell === undefined) return false
              const a = cell as string | number
              const b = f.value as string | number
              if (f.op === '<') return a < b
              if (f.op === '<=') return a <= b
              if (f.op === '>') return a > b
              return a >= b
            }
            case 'in':
              return f.values.includes(cell as string)
          }
        }),
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
