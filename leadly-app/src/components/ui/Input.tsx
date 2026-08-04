import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { EyeIcon, EyeOffIcon } from '../icons'

type BaseInputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }

const FIELD_BASE =
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

/** Input with a leading icon (email, search, etc.) -- the standard field shape for the login/auth screens. */
export function IconInput({
  icon,
  className = '',
  invalid = false,
  ...props
}: BaseInputProps & { icon: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-brand-300">{icon}</span>
      <input
        className={`${FIELD_BASE} pl-10 ${invalid ? 'border-red-400' : 'border-brand-200'} ${className}`}
        {...props}
      />
    </div>
  )
}

/** Password field with a leading lock icon and a show/hide toggle -- used everywhere a password is entered. */
export function PasswordInput({
  icon,
  className = '',
  invalid = false,
  ...props
}: BaseInputProps & { icon: ReactNode }) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-brand-300">{icon}</span>
      <input
        type={visible ? 'text' : 'password'}
        className={`${FIELD_BASE} pl-10 pr-10 ${invalid ? 'border-red-400' : 'border-brand-200'} ${className}`}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        className="absolute inset-y-0 right-0 flex items-center pr-3 text-brand-300 hover:text-brand-500"
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}
