export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const bucket = out.get(k)
    if (bucket) bucket.push(r)
    else out.set(k, [r])
  }
  return out
}

export function sortBy<T, K extends string | number>(rows: T[], key: (r: T) => K): T[] {
  return rows.slice().sort((a, b) => {
    const ka = key(a), kb = key(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

export function leftJoin<L, R>(
  left: L[],
  right: R[],
  leftKey: (l: L) => string,
  rightKey: (r: R) => string,
): Array<L & Partial<R>> {
  const idx = new Map<string, R>()
  for (const r of right) idx.set(rightKey(r), r)
  return left.map(l => ({ ...l, ...(idx.get(leftKey(l)) ?? {}) }))
}

/** Equivalent to pandas: s.shift(1).rolling(window, min_periods=1).sum().
 *  Index 0 returns 0 (no prior data). Index i returns sum of values[max(0,i-window):i]. */
export function rollingSumPriorOnly(values: Array<number | null | undefined>, window: number): number[] {
  const out: number[] = new Array(values.length).fill(0)
  for (let i = 0; i < values.length; i++) {
    let s = 0
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = values[j]
      if (typeof v === 'number' && Number.isFinite(v)) s += v
    }
    out[i] = s
  }
  return out
}
