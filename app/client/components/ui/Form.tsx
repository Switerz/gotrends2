import {
  type SelectHTMLAttributes,
  type InputHTMLAttributes,
  forwardRef,
} from 'react'
import clsx from 'clsx'

// Inline SVG chevron, URL-encoded for use as CSS background.
// stroke #B6B7C2 is ink-200, matches the body text color.
const CHEVRON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23B6B7C2' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 4.5 6 7.5 9 4.5'/></svg>\")"

const FIELD_BASE =
  'bg-ink-800 hairline rounded-card text-sm text-ink-100 font-sans ' +
  'focus:outline-none focus:ring-2 focus:ring-sage/30 focus:border-ink-500 ' +
  'hover:border-ink-500 transition-all duration-200 ease-editorial ' +
  'disabled:opacity-40 disabled:cursor-not-allowed'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        {...rest}
        className={clsx(
          FIELD_BASE,
          'appearance-none cursor-pointer pl-3 pr-9 py-2 min-w-[160px] bg-no-repeat',
          className,
        )}
        style={{
          backgroundImage: CHEVRON,
          backgroundPosition: 'right 0.75rem center',
          backgroundSize: '12px 12px',
        }}
      >
        {children}
      </select>
    )
  },
)

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        {...rest}
        className={clsx(
          FIELD_BASE,
          'px-3 py-2 placeholder:text-ink-400',
          className,
        )}
      />
    )
  },
)
