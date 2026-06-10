import { ParityViolation } from '@/core/errors'

type Opts = { keyCols: string[]; tolerance?: number; ignore?: string[] }

export function assertParity<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  actual: A[],
  expected: B[],
  opts: Opts,
): void {
  const tol = opts.tolerance ?? 1e-6
  const ignore = new Set(opts.ignore ?? [])

  if (actual.length !== expected.length) {
    throw new ParityViolation('__row_count__', actual.length, expected.length)
  }

  const keyOf = (r: Record<string, unknown>) =>
    opts.keyCols.map(k => String(r[k])).join('|')

  const idx = new Map(expected.map(r => [keyOf(r), r]))

  for (const a of actual) {
    const e = idx.get(keyOf(a))
    if (!e) throw new ParityViolation('__missing_row__', keyOf(a), 'expected row not found')

    for (const col of Object.keys(e)) {
      if (ignore.has(col)) continue
      const av = a[col], ev = e[col]

      if (typeof ev === 'number' && Number.isFinite(ev)) {
        const an = typeof av === 'number' ? av : Number(av)
        if (!Number.isFinite(an) || Math.abs(an - ev) > tol) {
          throw new ParityViolation(`${keyOf(a)}.${col}`, av, ev)
        }
      } else if (ev === null || ev === '' || ev === undefined) {
        const isAvEmpty =
          av === null || av === '' || av === undefined ||
          (typeof av === 'number' && Number.isNaN(av))
        if (!isAvEmpty) {
          throw new ParityViolation(`${keyOf(a)}.${col}`, av, null)
        }
      } else {
        if (String(av) !== String(ev)) {
          throw new ParityViolation(`${keyOf(a)}.${col}`, av, ev)
        }
      }
    }
  }
}
