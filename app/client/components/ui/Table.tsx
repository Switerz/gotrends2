import { type ReactNode } from 'react'
import clsx from 'clsx'

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  // Horizontal scroll on overflow — child stays within Card boundaries.
  // The wrapper preserves the Card's rounded corners because the parent Card has overflow-hidden.
  return (
    <div className="w-full overflow-x-auto">
      <table className={clsx('w-full border-collapse min-w-max', className)}>{children}</table>
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="hairline-b">{children}</thead>
}

export function TH({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={clsx(
        'text-left px-4 py-3 text-[10px] uppercase tracking-[0.08em] font-mono text-ink-300 font-medium',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>
}

export function TR({
  children,
  onClick,
  className,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        'hairline-b last:border-0 transition-colors duration-200 ease-editorial',
        onClick && 'cursor-pointer hover:bg-ink-700/50',
        className,
      )}
    >
      {children}
    </tr>
  )
}

export function TD({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={clsx('px-4 py-3 text-sm', className)}>{children}</td>
}
