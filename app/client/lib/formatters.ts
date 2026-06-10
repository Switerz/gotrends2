export function fmtBrl(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v).toFixed(2)
  const [intPart, dec] = abs.split('.')
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}R$ ${grouped},${dec}`
}

export function fmtPct(v: number | null | undefined, fractionDigits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(fractionDigits).replace('.', ',')}%`
}

export function fmtNumber(v: number | null | undefined, fractionDigits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(fractionDigits).replace('.', ',')
}

export function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime()
  const now = Date.now()
  const s = Math.round((now - t) / 1000)
  if (s < 60) return `há ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m}min`
  const h = Math.round(m / 60)
  if (h < 24) return `há ${h}h`
  const d = Math.round(h / 24)
  return `há ${d}d`
}
