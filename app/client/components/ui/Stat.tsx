import { type ReactNode } from 'react'
import clsx from 'clsx'
import { Card } from './Card'

interface Props {
  label: string
  value: ReactNode
  delta?: { value: string; tone: 'sage' | 'coral' | 'neutral' }
  hint?: string
}

export function Stat({ label, value, delta, hint }: Props) {
  return (
    <Card hover>
      <div className="px-5 py-4">
        <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-300 mb-3">
          {label}
        </div>
        <div className="flex items-baseline gap-3">
          <div className="font-display text-4xl text-ink-100 tabular-nums">{value}</div>
          {delta && (
            <span
              className={clsx(
                'text-xs font-mono tabular-nums',
                delta.tone === 'sage'
                  ? 'text-sage'
                  : delta.tone === 'coral'
                    ? 'text-coral'
                    : 'text-ink-300',
              )}
            >
              {delta.value}
            </span>
          )}
        </div>
        {hint && <div className="text-[11px] text-ink-400 mt-2">{hint}</div>}
      </div>
    </Card>
  )
}
