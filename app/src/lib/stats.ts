export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function clean(values: Array<number | null | undefined>): number[] {
  return values.filter(isFiniteNumber) as number[]
}

export function mean(values: Array<number | null | undefined>): number {
  const c = clean(values)
  if (c.length === 0) return NaN
  return c.reduce((a, b) => a + b, 0) / c.length
}

export function median(values: Array<number | null | undefined>): number {
  const c = clean(values).slice().sort((a, b) => a - b)
  if (c.length === 0) return NaN
  const m = Math.floor(c.length / 2)
  return c.length % 2 ? c[m]! : (c[m - 1]! + c[m]!) / 2
}

export function mad(values: Array<number | null | undefined>): number {
  const c = clean(values)
  if (c.length === 0) return NaN
  const med = median(c)
  return median(c.map(v => Math.abs(v - med)))
}

/** EWMA equivalent to pandas .ewm(alpha=α, adjust=False).mean(): s_t = α·x_t + (1-α)·s_{t-1} */
export function ewma(values: Array<number | null | undefined>, alpha: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  let s: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!isFiniteNumber(v)) { out[i] = s ?? NaN; continue }
    s = s === null ? v : alpha * v + (1 - alpha) * s
    out[i] = s
  }
  return out
}

/** Slope of OLS y = a + b·x. Returns NaN if var(x) is ~0 or n < 3. */
export function olsSlope(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return NaN
  const xb = mean(x), yb = mean(y)
  let num = 0, den = 0
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - xb
    num += dx * (y[i]! - yb)
    den += dx * dx
  }
  if (den < 1e-12) return NaN
  return num / den
}

/** pandas.qcut(rank(method='first'), n_bands, labels=False, duplicates='drop').add(1).
 *  Returns the 1-based band index per element preserving original order.
 *
 *  Implementation note: pandas qcut on contiguous ranks 1..N places bin edges at
 *  the linear quantiles 1 + (N-1)*i/k for i = 1..k-1, and assigns each rank to
 *  the first bin whose right edge is >= rank. The naive floor(((r-1)*k)/N)
 *  formula diverges from pandas for many N (e.g. N=55, k=4). */
export function qcutRanks(values: number[], nBands: number): number[] {
  if (values.length === 0) return []
  if (values.length === 1) return [1]
  const n = values.length
  const bands = Math.min(nBands, n)
  // rank(method='first'): rank by value, ties broken by original index
  const ranked = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v || a.i - b.i)
    .map((o, rank) => ({ ...o, rank: rank + 1 }))
  // Bin edges at 1 + (n-1)*i/bands for i=1..bands-1. A rank r belongs to band i
  // iff edges[i-1] < r <= edges[i] (with edges[0]=1, edges[bands]=n).
  // Equivalent closed-form: ceil((r-1)*bands / (n-1)), clamped to [1, bands].
  const bucketed = ranked.map(o => {
    if (o.rank === 1) return { i: o.i, band: 1 }
    const raw = Math.ceil(((o.rank - 1) * bands) / (n - 1))
    return { i: o.i, band: Math.max(1, Math.min(bands, raw)) }
  })
  bucketed.sort((a, b) => a.i - b.i)
  return bucketed.map(b => b.band)
}
