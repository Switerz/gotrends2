// dev/db.ts
//
// Local SQLite adapter that conforms to the Godeploy `env.DB` interface
// (see src/db/bootstrap.ts → GodeployDB). Used ONLY by the dev server so we
// can run the same Hono Worker against a node-backed SQLite during local
// development without changing any production code paths.

import Database from 'better-sqlite3'
import type { GodeployDB } from '../src/db/bootstrap'

/** Wraps better-sqlite3 to match the Godeploy `env.DB` interface. */
export function createLocalDb(
  path = ':memory:',
): GodeployDB & { _raw: Database.Database } {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const isQuery = (sql: string): boolean => {
    const trimmed = sql.trimStart().toLowerCase()
    return trimmed.startsWith('select') || trimmed.startsWith('with')
  }

  return {
    _raw: sqlite,
    async exec(sql, params = []) {
      // Some DDL bodies are single statements with no placeholders. better-sqlite3's
      // exec() is the only API that handles multi-statement bodies, but prepare/run
      // is safer for single statements with bound params. Heuristic: if no `?`
      // placeholders, fall back to exec() which is tolerant of trailing semicolons
      // and DDL-only payloads.
      if (params.length === 0 && !/\?/.test(sql)) {
        sqlite.exec(sql)
        return { rowsWritten: 0 }
      }
      const stmt = sqlite.prepare(sql)
      const info = stmt.run(...(params as unknown[]))
      return { rowsWritten: info.changes }
    },
    async query(sql, params = []) {
      const stmt = sqlite.prepare(sql)
      if (!isQuery(sql)) {
        // A few call sites use query() for writes. Forward to run() so we don't
        // explode on UPDATE/DELETE statements that lack a result set.
        const info = stmt.run(...(params as unknown[]))
        return { columns: [], rows: [], rowsRead: info.changes }
      }
      const rows = stmt.all(...(params as unknown[])) as Record<string, unknown>[]
      const columns = rows[0] ? Object.keys(rows[0]) : []
      const matrix = rows.map((r) => columns.map((c) => r[c]))
      return { columns, rows: matrix, rowsRead: rows.length }
    },
  }
}
