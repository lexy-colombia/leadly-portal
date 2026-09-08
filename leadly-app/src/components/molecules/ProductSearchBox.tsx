import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ScanIcon } from '@/components/atoms/icons'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Barra de búsqueda de productos compartida entre el POS (PosFastCheckout)
 * y el panel "Agregar producto" del editor de ítems de una orden
 * (OrderItemsEditor) -- antes cada uno tenía su propio input + lista de
 * resultados, sin manejo de teclado. Pedido explícito del usuario: un solo
 * componente, navegable 100% sin mouse (flecha abajo/arriba recorre los
 * resultados resaltando uno a la vez, Enter lo selecciona) y que limpie el
 * texto buscado al seleccionar -- así el foco queda listo para escanear/
 * tipear el siguiente producto sin tener que borrar a mano lo anterior.
 *
 * El caller sigue siendo dueño de cómo se ve cada fila (`renderResult`,
 * normalmente un `ProductSearchResultRow`) porque el POS necesita precio/
 * stock ahí mismo y el editor de ítems de orden no. `onEnter` es el
 * fallback cuando Enter se presiona sin ningún resultado resaltado (match
 * exacto de código de barras, mismo comportamiento que ya tenía cada uno).
 *
 * Con un resultado resaltado (flecha abajo/arriba), flecha derecha/
 * izquierda ya no mueve el cursor de texto -- ajusta cuánto agregar (pedido
 * explícito del usuario: elegir la cantidad ahí mismo, sin tener que
 * agregar de a 1 y corregir después con el stepper). Ese ajuste solo aplica
 * mientras hay algo resaltado -- sin resaltado ninguna, las flechas
 * izquierda/derecha siguen moviendo el cursor del input normalmente.
 * `onSelect` recibe esa cantidad tanto si se confirma con Enter como con
 * click; se resetea a 1 en cada selección y en cada búsqueda nueva.
 */
export function ProductSearchBox<T>({
  inputRef,
  value,
  onChange,
  onEnter,
  results,
  getKey,
  renderResult,
  onSelect,
  placeholder,
  autoFocus = false,
  loading = false,
  loadingLabel,
  emptyLabel,
  hint,
  error,
  className,
  inputClassName,
}: {
  inputRef?: RefObject<HTMLInputElement | null>
  value: string
  onChange: (value: string) => void
  /** Fallback cuando se presiona Enter sin ningún resultado resaltado con
   * las flechas -- ej. match exacto de código de barras. */
  onEnter?: () => void
  results: T[]
  getKey: (item: T) => string
  renderResult: (item: T, highlighted: boolean, select: () => void) => ReactNode
  onSelect: (item: T, quantity: number) => void
  placeholder: string
  autoFocus?: boolean
  loading?: boolean
  loadingLabel?: ReactNode
  emptyLabel?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  className?: string
  inputClassName?: string
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [quantity, setQuantity] = useState(1)
  const itemRefs = useRef<Array<HTMLDivElement | null>>([])

  // Cada búsqueda nueva (o el reset a [] al seleccionar/limpiar) arranca sin
  // nada resaltado y sin cantidad ajustada -- si no, un índice/cantidad
  // vieja podía quedar aplicada a un resultado distinto del que el usuario
  // ve tras escribir una letra más.
  useEffect(() => {
    setHighlightedIndex(-1)
    setQuantity(1)
  }, [results])

  useEffect(() => {
    if (highlightedIndex < 0) return
    itemRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  function handleSelect(item: T) {
    onSelect(item, quantity)
    setHighlightedIndex(-1)
    setQuantity(1)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length === 0) return
      e.preventDefault()
      setHighlightedIndex((i) => {
        if (e.key === 'ArrowDown') return (i + 1) % results.length
        return i <= 0 ? results.length - 1 : i - 1
      })
      return
    }
    // Solo mientras hay un resultado resaltado -- si no, estas mismas
    // teclas siguen moviendo el cursor de texto del input, comportamiento
    // nativo que no hay que romper mientras se está tipeando la búsqueda.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && highlightedIndex >= 0) {
      e.preventDefault()
      setQuantity((q) => (e.key === 'ArrowRight' ? q + 1 : Math.max(1, q - 1)))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedIndex >= 0 && highlightedIndex < results.length) {
        handleSelect(results[highlightedIndex])
      } else {
        onEnter?.()
      }
      return
    }
    if (e.key === 'Escape') {
      setHighlightedIndex(-1)
      setQuantity(1)
    }
  }

  const showList = results.length > 0 || loading || emptyLabel != null

  return (
    <div className={className}>
      <div className="relative">
        <ScanIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-brand-300" />
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={cn('pl-9 text-xs', highlightedIndex >= 0 && 'pr-12', inputClassName)}
        />
        {highlightedIndex >= 0 && (
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md bg-accent-100 px-1.5 py-0.5 text-[11px] font-semibold text-accent-700">
            ×{quantity}
          </span>
        )}
      </div>
      {hint}
      {error && <p className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}

      {showList && (
        <div className="mt-2 max-h-72 divide-y divide-brand-100 overflow-y-auto rounded-lg border border-brand-100">
          {loading && <p className="px-3 py-3 text-xs text-brand-400">{loadingLabel}</p>}
          {!loading && results.length === 0 && emptyLabel && <p className="px-3 py-4 text-center text-xs text-brand-400">{emptyLabel}</p>}
          {!loading &&
            results.map((item, i) => (
              <div key={getKey(item)} ref={(el) => { itemRefs.current[i] = el }} className="relative">
                {renderResult(item, i === highlightedIndex, () => handleSelect(item))}
                {i === highlightedIndex && quantity > 1 && (
                  <span className="pointer-events-none absolute top-1 right-1.5 rounded-full bg-accent-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    ×{quantity}
                  </span>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
