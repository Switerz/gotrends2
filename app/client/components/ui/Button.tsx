import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react'
import clsx from 'clsx'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'link'
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'primary', className, children, ...rest },
  ref,
) {
  const base =
    'inline-flex items-center gap-2 font-sans text-sm font-medium transition-all duration-200 ease-editorial focus:outline-none focus:ring-2 focus:ring-sage/30 focus:ring-offset-2 focus:ring-offset-ink-900 disabled:opacity-40 disabled:cursor-not-allowed'
  const variants = {
    primary:
      'px-4 py-2 bg-sage text-ink-900 rounded-card hover:bg-sage/90 hover:-translate-y-px hover:shadow-soft-lift',
    ghost:
      'px-4 py-2 hairline rounded-card text-ink-100 hover:bg-ink-700 hover:-translate-y-px',
    link: 'text-sage hover:underline underline-offset-4 decoration-sage/40',
  }
  return (
    <button ref={ref} className={clsx(base, variants[variant], className)} {...rest}>
      {children}
    </button>
  )
})
