import { Loader2Icon, MinusIcon, PlusIcon } from 'lucide-react'

/** Stepper de cantidad: input editable + botón − y botón + a los lados,
 * dentro de una sola caja con borde. Extraído del stepper del catálogo
 * público (antes vivía solo en ProductCardAction, ver ProductCard.tsx) para
 * que POS y Órdenes usen exactamente el mismo componente en vez de cada uno
 * reimplementar su propia versión -- pedido explícito del usuario. */
interface QuantityStepperProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  /** Deshabilita solo el botón +, ej. sin stock disponible, sin bloquear el
   * resto del control (todavía se puede escribir o disminuir). */
  disableIncrement?: boolean
  /** Muestra el badge de "guardando" (uso con useDebouncedQuantity). */
  saving?: boolean
  /** Resalta el control en rojo, ej. cantidad por encima del stock real. */
  invalid?: boolean
  decreaseLabel: string
  increaseLabel: string
  className?: string
}

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  disabled = false,
  disableIncrement = false,
  saving = false,
  invalid = false,
  decreaseLabel,
  increaseLabel,
  className = '',
}: QuantityStepperProps) {
  const atMin = value <= min
  const atMax = max !== undefined && value >= max

  function commit(next: number) {
    const floored = Math.floor(next) || 0
    const clamped = max !== undefined ? Math.min(max, Math.max(min, floored)) : Math.max(min, floored)
    onChange(clamped)
  }

  return (
    <div
      className={`relative flex h-7 items-center justify-between rounded-lg border transition-colors ${
        invalid ? 'border-red-400' : saving ? 'border-primary/60' : 'border-border'
      } ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      <button
        type="button"
        onClick={() => commit(value - step)}
        disabled={disabled || atMin}
        className="flex h-full flex-1 items-center justify-center text-foreground hover:bg-muted disabled:opacity-40"
        aria-label={decreaseLabel}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => commit(Number(e.target.value))}
        className={`w-8 border-0 bg-transparent text-center text-xs font-medium outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
          invalid ? 'text-red-700' : 'text-foreground'
        }`}
      />
      <button
        type="button"
        onClick={() => commit(value + step)}
        disabled={disabled || disableIncrement || atMax}
        className="flex h-full flex-1 items-center justify-center text-foreground hover:bg-muted disabled:opacity-40"
        aria-label={increaseLabel}
      >
        <PlusIcon className="size-3.5" />
      </button>
      {saving && (
        <span className="absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-background">
          <Loader2Icon className="size-3 animate-spin text-primary" />
        </span>
      )}
    </div>
  )
}
