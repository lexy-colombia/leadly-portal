import type { TextareaHTMLAttributes } from 'react'

export function Textarea({
  className = '',
  invalid = false,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={`w-full rounded-xl border px-3.5 py-2.5 text-sm text-brand-800 placeholder:text-brand-300 transition-shadow duration-150 focus:outline-none focus:ring-2 focus:ring-accent-400/60 focus:border-accent-400 ${invalid ? 'border-red-400' : 'border-brand-200'} ${className}`}
      {...props}
    />
  )
}
