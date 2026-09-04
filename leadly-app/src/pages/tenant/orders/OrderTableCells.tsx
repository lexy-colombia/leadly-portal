import { PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import type { OrderPaymentMethod } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'

/** Celdas compartidas de la tabla de Ventas -- viven acá y no dentro de
 * Orders.tsx porque el POS ("cuentas abiertas", sin puntos de venta
 * configurados) usa exactamente la misma tabla, sin las columnas de envío.
 * Una sola implementación: si cambia el diseño de la celda, cambia en las
 * dos vistas a la vez. */

/** Método principal (el de mayor monto) de una orden -- texto simple, sin
 * barra ni porcentaje (pedido explícito del usuario, referencia de diseño).
 * `methods` ya viene ordenado de mayor a menor monto. */
export function OrderPaymentMethodCell({ methods }: { methods: { method: OrderPaymentMethod; amount: number }[] | undefined }) {
  const { t } = useLanguage()
  if (!methods || methods.length === 0) return <span className="text-xs text-brand-300">—</span>
  return <span className="text-xs text-brand-700">{t(PAYMENT_METHOD_LABEL_KEY[methods[0].method])}</span>
}

/** Una línea de la columna "Estados" -- etiqueta ("Estado de entrega:") +
 * bullet de color + valor, en vez de un badge tipo pill (pedido explícito
 * del usuario, referencia de diseño). `null` en vez de un dot cuando el
 * estado no aplica (ej. envío de una cotización que nunca se despachó). */
export function StatusDotLine({ label, dotClass, value }: { label: string; dotClass: string | null; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] whitespace-nowrap">
      <span className="text-brand-400">{label}</span>
      {dotClass && <span className={`inline-block size-1.5 shrink-0 rounded-full ${dotClass}`} />}
      <span className="text-brand-700">{value}</span>
    </div>
  )
}
