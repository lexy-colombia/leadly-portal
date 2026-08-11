import { forwardRef, useEffect, useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react'
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

/** Digits only (no sign/decimal) grouped every 3 from the right, Colombian
 * style: "1234567" -> "1.234.567". */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** Raw numeric string (what the app actually stores, JS-parseable with `.`
 * as the decimal separator) -> the localized text shown in the box
 * ("1234567.5" -> "1.234.567,5"). */
function toDisplay(raw: string | number | readonly string[] | undefined): string {
  if (raw === undefined || raw === null || raw === '') return ''
  const [intPart, decPart] = String(raw).split('.')
  const intDigits = intPart.replace(/\D/g, '')
  const grouped = intDigits ? groupThousands(intDigits) : intDigits
  return decPart !== undefined ? `${grouped},${decPart}` : grouped
}

/** Reverse of toDisplay -- strips the thousands dots and swaps the decimal
 * comma back to a dot, e.g. while the user types "1.234.567,5" this is
 * "1234567.5", exactly the string `Number()` (and every caller's own
 * `Number(value)` at submit time) already expects. */
function toRaw(display: string): string {
  const cleaned = display.replace(/[^\d,]/g, '')
  const [intPart, decPart] = cleaned.split(',')
  return decPart !== undefined ? `${intPart}.${decPart}` : intPart
}

/** Generic money-entry field -- a leading "$" instead of an icon, and
 * thousands/decimal separators formatted as you type (Colombian style: "."
 * groups thousands, "," is the decimal mark), used everywhere a peso amount
 * is typed (precios de producto, valor de oportunidad, montos de pago/
 * factura, envío/impuestos de una venta...) so every currency input in the
 * app looks and behaves the same instead of each screen rolling its own
 * `type="number"`.
 *
 * Renders as a `type="text"` field (a native `type="number"` can't display
 * "1.234.567" -- browsers reject anything but a plain numeric string), but
 * the `value`/`onChange` contract callers see is unchanged: `value` is still
 * the raw numeric string/number, and `onChange`'s `e.target.value` is still
 * that same raw, unformatted string (dot decimal, no thousands separators)
 * -- only what's drawn in the box is formatted. Existing callers doing
 * `Number(e.target.value)` or storing it straight into form state keep
 * working with zero changes. */
export function CurrencyInput({
  className = '',
  invalid = false,
  currency = '$',
  value,
  onChange,
  ...props
}: Omit<BaseInputProps, 'value' | 'onChange'> & {
  currency?: string
  value?: string | number | readonly string[]
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  const [display, setDisplay] = useState(() => toDisplay(value))

  // Keeps the box in sync when the caller resets/loads `value` from
  // elsewhere (e.g. opening a drawer to edit an existing record) -- typing
  // itself is handled locally in handleChange, not by round-tripping
  // through this effect on every keystroke.
  useEffect(() => {
    setDisplay(toDisplay(value))
  }, [value])

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = toRaw(e.target.value)
    setDisplay(toDisplay(raw))
    // Callers only ever read `.value` off this (see every existing
    // CurrencyInput usage) -- a minimal fake event avoids trying to spread a
    // real DOM node, whose actual properties live on the prototype and
    // don't survive `{...e.target}`.
    onChange?.({ target: { value: raw } } as ChangeEvent<HTMLInputElement>)
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-sm text-brand-400">{currency}</span>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onChange={handleChange}
        className={`${FIELD_BASE} pl-7 ${invalid ? 'border-red-400' : 'border-brand-200'} ${className}`}
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
