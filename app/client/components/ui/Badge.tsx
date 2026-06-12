import { type ReactNode } from 'react'
import clsx from 'clsx'

export type Tone = 'sage' | 'amber' | 'coral' | 'cobalt' | 'neutral' | 'gold'

const TONE_CLASSES: Record<Tone, string> = {
  sage: 'text-sage bg-sage-wash border-sage-dim/40',
  amber: 'text-amber bg-amber-wash border-amber-dim/40',
  coral: 'text-coral bg-coral-wash border-coral-dim/40',
  cobalt: 'text-cobalt bg-cobalt-wash border-cobalt-dim/40',
  gold: 'text-gold bg-ink-700 border-gold-dim/40',
  neutral: 'text-ink-200 bg-ink-700 border-ink-500',
}

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill border text-[10px] uppercase tracking-[0.08em] font-mono font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Status-to-tone mapper specific to RecommendationStatus values. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'pending':
      return 'neutral'
    case 'sent_to_chat':
      return 'cobalt'
    case 'approved':
      return 'sage'
    case 'rejected':
      return 'coral'
    case 'expired':
      return 'amber'
    case 'executing':
      return 'cobalt'
    case 'executed':
      return 'sage'
    case 'failed':
      return 'coral'
    default:
      return 'neutral'
  }
}

export function guardrailTone(status: string): Tone {
  switch (status) {
    case 'ok':
      return 'sage'
    case 'needs_human_review':
      return 'amber'
    case 'blocked':
      return 'coral'
    default:
      return 'neutral'
  }
}

export function riskTone(risk: string | null): Tone {
  switch (risk) {
    case 'low':
      return 'sage'
    case 'medium':
      return 'amber'
    case 'high':
      return 'coral'
    default:
      return 'neutral'
  }
}

export function biddingLearningTone(status: string): Tone {
  switch (status) {
    case 'stable':
      return 'sage'
    case 'learning':
      return 'amber'
    case 'limited':
      return 'coral'
    default:
      return 'neutral'
  }
}

export function verificationTone(status: string): Tone {
  switch (status) {
    case 'match':
      return 'sage'
    case 'drifted':
      return 'amber'
    case 'reverted':
      return 'coral'
    default:
      return 'neutral'
  }
}

/** PT-BR label for a verification status; falls through to the raw enum. */
export function verificationLabel(status: string): string {
  switch (status) {
    case 'match':
      return 'aplicado'
    case 'drifted':
      return 'drift detectado'
    case 'reverted':
      return 'revertido'
    case 'unavailable':
      return 'não verificável'
    default:
      return status
  }
}
