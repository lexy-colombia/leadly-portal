import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'ghost-dark'

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100'

// Each variant is a self-contained, non-overlapping utility set (bg + text + border + hover).
// Never fine-tune a variant's colors by appending conflicting utilities via `className` from a
// caller: Tailwind's cascade is resolved by stylesheet generation order, not by class-attribute
// order, so e.g. appending `text-brand-200` to override `ghost`'s `text-brand-700` is not
// guaranteed to win -- this previously rendered the sign-out button invisible on the dark
// sidebar. Add a new variant instead, as done here with `ghost-dark`.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-700 text-white shadow-sm shadow-brand-700/20 hover:bg-brand-600 hover:shadow-md hover:shadow-brand-700/25',
  secondary: 'bg-accent-500 text-white shadow-sm shadow-accent-500/25 hover:bg-accent-600 hover:shadow-md hover:shadow-accent-500/30',
  danger: 'bg-red-600 text-white shadow-sm shadow-red-600/20 hover:bg-red-500 hover:shadow-md hover:shadow-red-600/25',
  ghost: 'border border-brand-200 text-brand-700 hover:border-brand-300 hover:bg-brand-50',
  'ghost-dark': 'border border-brand-600 text-brand-200 hover:bg-brand-600 hover:text-white',
}

export function Button({
  className = '',
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={`${BASE} ${VARIANTS[variant]} ${className}`} {...props} />
}
