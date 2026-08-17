import { forwardRef, type InputHTMLAttributes } from 'react'

type BaseInputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }

export const FIELD_BASE =
  'w-full rounded-xl border px-3.5 py-2.5 text-sm text-brand-800 placeholder:text-brand-300 transition-shadow duration-150 focus:outline-none focus:ring-2 focus:ring-accent-400/60 focus:border-accent-400 disabled:cursor-not-allowed disabled:bg-brand-50'

export const Input = forwardRef<HTMLInputElement, BaseInputProps>(function Input(
  { className = '', invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`${FIELD_BASE} ${invalid ? 'border-red-400' : 'border-brand-200'} ${className}`}
      {...props}
    />
  )
})
