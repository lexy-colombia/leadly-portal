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
/** Firma de un juego de líneas (+ envío): la que usa el hook para saber a qué
 * líneas corresponde un desglose. Quien vaya a COBRAR o IMPRIMIR con un
 * desglose comparte esta comparación: solo se usa si su firma coincide con la
 * de las líneas vigentes (`totalsSignature` del hook), nunca "lo último que
 * hubiera en pantalla". */
export function orderTotalsSignature(items: OrderItemInput[], shipping = 0): string {
  return JSON.stringify({ shipping, items })
}

/** Desglose que ya devolvió un guardado del carrito para EXACTAMENTE estos
 * ítems (`items` es la lista que se guardó). Mientras las líneas en pantalla
 * sigan siendo esas, el hook usa esto y no pide un preview; en cuanto cambian,
 * vuelve al preview de siempre. */
export interface PrefetchedTotals {
  items: OrderItemInput[]
  totals: OrderTotalsBreakdown
  stockShortfalls: StockShortfall[]
}

export function useOrderTotalsPreview(
  items: OrderItemInput[],
  shipping = 0,
  {
    debounceMs = 400,
    prefetched = null,
    hold = false,
  }: {
    debounceMs?: number
    /** Totales ya calculados por el servidor al guardar (contrato de
     * calculate-order, 2026-09-21). Solo se usan si coinciden con `items`. */
    prefetched?: PrefetchedTotals | null
    /** true mientras se guarda exactamente este juego de líneas: el guardado
     * trae los totales, así que no se lanza un preview duplicado. Si el
     * guardado no los trae (o falla), `hold` vuelve a false y el preview corre
     * como siempre. No cancela ni atenúa un preview ya pedido o resuelto. */
    hold?: boolean
  } = {},
): {
  totals: OrderTotalsBreakdown | null
  /** Firma (`orderTotalsSignature`) de las líneas a las que corresponde `totals`; null si no hay desglose. */
  totalsSignature: string | null
  stockShortfalls: StockShortfall[]
  loading: boolean
  error: string | null
} {
  const [totals, setTotals] = useState<OrderTotalsBreakdown | null>(null)
  const [totalsSignature, setTotalsSignature] = useState<string | null>(null)
  const [stockShortfalls, setStockShortfalls] = useState<StockShortfall[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Solo la última petición pedida puede escribir el estado -- sin esto,
  // una respuesta lenta de hace tres escaneos puede pisar la actual.
  const requestRef = useRef(0)
  // Firma de la petición VIVA (en vuelo y todavía válida: su requestId sigue
  // siendo el vigente), o null. Cada vez que se invalida una petición
  // (`++requestRef`) se limpia acá: si no, volver a esa firma creería que ya
  // hay algo en vuelo y no la pediría de nuevo, y `loading` quedaría en true
  // para siempre (la respuesta invalidada se descarta).
  const inflightSigRef = useRef<string | null>(null)
  // Firma cuyo resultado ya está en `totals` (resuelto por preview o adoptado
  // de un guardado). Invariante: `loading` solo está en true si hay un timer
  // pendiente, un `hold` esperando un guardado, o una petición viva.
  const settledSigRef = useRef<string | null>(null)

  const signature = orderTotalsSignature(items, shipping)
  const prefetchedMatches = prefetched !== null && orderTotalsSignature(prefetched.items, shipping) === signature

  useEffect(() => {
    if (items.length === 0) {
      requestRef.current += 1
      inflightSigRef.current = null
      settledSigRef.current = null
      setTotals(null)
      setTotalsSignature(null)
      setStockShortfalls([])
      setLoading(false)
      setError(null)
      return
    }
    if (prefetchedMatches && prefetched) {
      // Adopta lo que devolvió el guardado y cancela cualquier preview de
      // versiones anteriores que siga en vuelo.
      requestRef.current += 1
      inflightSigRef.current = null
      settledSigRef.current = signature
      setTotals(prefetched.totals)
      setTotalsSignature(signature)
      setStockShortfalls(prefetched.stockShortfalls)
      setError(null)
      setLoading(false)
      return
    }
    if (settledSigRef.current === signature) {
      // Ya hay resultado para estas líneas (p. ej. se volvió a ellas tras una
      // edición pasajera): se invalida cualquier petición de otra firma que
      // siga en vuelo para que no pise `totals` con líneas que ya no son.
      if (inflightSigRef.current !== null) {
        requestRef.current += 1
        inflightSigRef.current = null
      }
      setLoading(false)
      return
    }
    if (inflightSigRef.current === signature) {
      // Petición viva para estas mismas líneas (el efecto se re-evaluó por
      // `hold`/`prefetched`): se deja correr, no se duplica.
      setLoading(true)
      return
    }
    setLoading(true)
    const requestId = ++requestRef.current
    inflightSigRef.current = null
    if (hold) return
    const timer = setTimeout(() => {
      inflightSigRef.current = signature
      previewOrderTotalsWithStock(items, shipping)
        .then((result) => {
          if (requestRef.current !== requestId) return
          inflightSigRef.current = null
          settledSigRef.current = signature
          setTotals(result.totals)
          setTotalsSignature(signature)
          setStockShortfalls(result.stockShortfalls)
          setError(null)
        })
        .catch((err: unknown) => {
          if (requestRef.current !== requestId) return
          inflightSigRef.current = null
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false)
        })
    }, debounceMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, debounceMs, prefetchedMatches, hold])

  if (prefetchedMatches && prefetched) return { totals: prefetched.totals, totalsSignature: signature, stockShortfalls: prefetched.stockShortfalls, loading: false, error: null }
  return { totals, totalsSignature, stockShortfalls, loading, error }
}
