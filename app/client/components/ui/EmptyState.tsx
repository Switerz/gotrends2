import { type ReactNode } from 'react'

interface Props {
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({ title, description, action }: Props) {
  return (
    <div className="hairline rounded-card bg-ink-800/50 py-16 px-8 text-center">
      <div className="font-display text-2xl text-ink-100 mb-2">{title}</div>
      {description && (
        <p className="text-sm text-ink-300 max-w-md mx-auto mb-6">{description}</p>
      )}
      {action}
    </div>
  )
}
