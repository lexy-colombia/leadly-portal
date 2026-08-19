import type { SelectHTMLAttributes } from 'react'

export function Select({
  className = '',
  invalid = false,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={`w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-brand-800 transition-shadow duration-150 focus:outline-none focus:ring-2 focus:ring-accent-400/60 focus:border-accent-400 ${invalid ? 'border-red-400' : 'border-brand-200'} ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}
