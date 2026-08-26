import { useEffect, useState } from 'react'
import { combinePhone, DEFAULT_DIAL_CODE, DIAL_CODES, splitPhone } from '../../lib/phone'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/** Indicativo (dropdown) + número local (input) -- de cara a quien la usa
 * sigue siendo un único string combinado en `value`/`onChange` (ej.
 * "573209149704"), igual que un `<input>` de teléfono normal: el split es
 * solo de presentación, no cambia el shape de datos en ningún lado
 * (clients.phone sigue siendo un solo campo). Mismo patrón que
 * CurrencyInput (components/molecules/Input.tsx): estado local para lo que
 * se ve en pantalla, resincronizado desde `value` en un efecto para cuando
 * el caller resetea el formulario (ej. abrir el drawer para otro contacto). */
export function PhoneInput({
  id,
  value,
  onChange,
  placeholder,
  className = '',
  disabled,
  invalid,
}: {
  id?: string
  value: string
  onChange: (phone: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  invalid?: boolean
}) {
  const [dialCode, setDialCode] = useState(() => splitPhone(value).dialCode || DEFAULT_DIAL_CODE)
  const [localNumber, setLocalNumber] = useState(() => splitPhone(value).localNumber)

  useEffect(() => {
    const next = splitPhone(value)
    setDialCode(next.dialCode || DEFAULT_DIAL_CODE)
    setLocalNumber(next.localNumber)
  }, [value])

  function handleDialCodeChange(code: string) {
    setDialCode(code)
    onChange(combinePhone(code, localNumber))
  }

  function handleLocalNumberChange(raw: string) {
    setLocalNumber(raw)
    onChange(combinePhone(dialCode, raw))
  }

  return (
    <div className={`flex gap-1.5 ${className}`}>
      <Select value={dialCode} onValueChange={handleDialCodeChange} disabled={disabled}>
        <SelectTrigger id={id ? `${id}-dial-code` : undefined} className="w-24 shrink-0">
          <SelectValue>{`+${dialCode}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {DIAL_CODES.map((c) => (
            <SelectItem key={c.code} value={c.code}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        value={localNumber}
        onChange={(e) => handleLocalNumberChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid}
        className="flex-1"
      />
    </div>
  )
}
