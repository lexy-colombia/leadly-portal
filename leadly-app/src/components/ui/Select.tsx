import type { ReactNode, SelectHTMLAttributes } from 'react'

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

/** Select with a leading icon that hints at what the field controls -- use whenever
 * the select's current value alone doesn't make its purpose obvious (e.g. a bare
 * "Consulta" or a person's name reads as decoration without a category/assignee cue). */
export function IconSelect({
  icon,
  className = '',
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; icon: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-brand-400">{icon}</span>
      <Select className={`pl-7 ${className}`} {...props} />
    </div>
  )
}
