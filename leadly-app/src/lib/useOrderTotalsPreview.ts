import { useEffect, useRef, useState } from 'react'
import { previewOrderTotals, type OrderItemInput, type OrderTotalsBreakdown } from './api/orders'

/** Pide el desglose de lo que se va a cobrar (base gravable, impuesto por
 * tarifa, total) cada vez que cambian las líneas, con debounce -- lo usan
 * las dos vistas del POS, que arman la venta antes de que exista ningún
 * pedido. Nunca calcula nada acá: el número siempre viene de
 * `calculate-order` en modo preview, el mismo cálculo que después persiste
 * el pedido real (regla del proyecto: cero lógica de negocio en el
 * frontend).
 *
 * `loading` no vacía los totales anteriores a propósito -- mientras llega
 * el desglose nuevo se sigue mostrando el viejo atenuado, en vez de
 * parpadear a un spinner en cada tecla del cajero. */
export function useOrderTotalsPreview(
  items: OrderItemInput[],
  shipping = 0,
  { debounceMs = 400 }: { debounceMs?: number } = {},
): { totals: OrderTotalsBreakdown | null; loading: boolean; error: string | null } {
  const [totals, setTotals] = useState<OrderTotalsBreakdown | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Solo la última petición pedida puede escribir el estado -- sin esto,
  // una respuesta lenta de hace tres escaneos puede pisar la actual.
  const requestRef = useRef(0)

  const signature = JSON.stringify({ shipping, items })

  useEffect(() => {
    if (items.length === 0) {
      requestRef.current += 1
      setTotals(null)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    const requestId = ++requestRef.current
    const timer = setTimeout(() => {
      previewOrderTotals(items, shipping)
        .then((result) => {
          if (requestRef.current !== requestId) return
          setTotals(result)
          setError(null)
        })
        .catch((err: unknown) => {
          if (requestRef.current !== requestId) return
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false)
        })
    }, debounceMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, debounceMs])

  return { totals, loading, error }
}
