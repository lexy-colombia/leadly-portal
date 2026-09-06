import { useEffect, useRef, useState } from 'react'
import { previewOrderTotalsWithStock, type OrderItemInput, type OrderTotalsBreakdown, type StockShortfall } from './api/orders'

/** Pide el desglose de lo que se va a cobrar (base gravable, impuesto por
 * tarifa, total) cada vez que cambian las líneas, con debounce -- lo usan
 * las dos vistas del POS, que arman la venta antes de que exista ningún
 * pedido. Nunca calcula nada acá: el número siempre viene de
 * `calculate-order` en modo preview, el mismo cálculo que después persiste
 * el pedido real (regla del proyecto: cero lógica de negocio en el
 * frontend).
 *
 * `stockShortfalls` (2026-09-06): la MISMA llamada trae también qué líneas
 * piden más de lo que hay en stock real -- el POS usa esta lista, y solo
 * esta, para pintar líneas en rojo y deshabilitar "Cobrar" (nunca compara
 * cantidades contra un `available` cacheado del lado del cliente).
 *
 * `loading` no vacía los totales/shortfalls anteriores a propósito --
 * mientras llega la respuesta nueva se sigue mostrando la vieja atenuada,
 * en vez de parpadear a un spinner en cada tecla del cajero. */
export function useOrderTotalsPreview(
  items: OrderItemInput[],
  shipping = 0,
  { debounceMs = 400 }: { debounceMs?: number } = {},
): { totals: OrderTotalsBreakdown | null; stockShortfalls: StockShortfall[]; loading: boolean; error: string | null } {
  const [totals, setTotals] = useState<OrderTotalsBreakdown | null>(null)
  const [stockShortfalls, setStockShortfalls] = useState<StockShortfall[]>([])
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
      setStockShortfalls([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    const requestId = ++requestRef.current
    const timer = setTimeout(() => {
      previewOrderTotalsWithStock(items, shipping)
        .then((result) => {
          if (requestRef.current !== requestId) return
          setTotals(result.totals)
          setStockShortfalls(result.stockShortfalls)
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

  return { totals, stockShortfalls, loading, error }
}
