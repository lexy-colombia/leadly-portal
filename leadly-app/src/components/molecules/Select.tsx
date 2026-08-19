import type { ReactNode, SelectHTMLAttributes } from 'react'
import { Select } from '@/components/atoms/Select'

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
