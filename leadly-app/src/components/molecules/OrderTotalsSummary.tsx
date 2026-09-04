import type { ReactNode } from 'react'
import { Loader2Icon } from 'lucide-react'
import type { OrderTotalsBreakdown } from '../../lib/api/orders'
import { useLanguage } from '../../contexts/LanguageContext'

/** Nombres cortos de tax_types (Tabla 11 del Anexo Técnico DIAN) para
 * etiquetar cada línea del desglose -- "IVA 19%", no "Impuesto 19%". El
 * catálogo completo vive en la tabla `tax_types`, pero traerlo por red solo
 * para pintar una etiqueta no vale un viaje extra en el POS; si un código
 * no está acá se cae al genérico "Impuesto". */
const TAX_TYPE_SHORT_NAME: Record<string, string> = {
  '01': 'IVA',
  '02': 'IC',
  '03': 'ICA',
  '04': 'INC',
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function Row({ label, value, muted = false, accent }: { label: ReactNode; value: ReactNode; muted?: boolean; accent?: 'positive' | 'negative' }) {
  const valueClass = accent === 'positive' ? 'text-emerald-600' : accent === 'negative' ? 'text-red-600' : 'text-brand-700'
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`min-w-0 truncate ${muted ? 'text-brand-400' : 'text-brand-500'}`}>{label}</span>
      <span className={`shrink-0 font-medium tabular-nums ${valueClass}`}>{value}</span>
    </div>
  )
}

/** Desglose de lo que se cobra -- base gravable, cada impuesto con su
 * tarifa, descuentos, envío y total, más (opcionalmente) lo ya pagado y el
 * saldo pendiente. Único lugar donde se pinta un resumen de totales:
 * lo usan el POS (venta rápida y cuentas abiertas) y el drawer de pago,
 * siempre con números que YA vienen calculados del servidor -- este
 * componente no hace ninguna cuenta de negocio, solo formatea. */
export function OrderTotalsSummary({
  totals,
  currency = 'COP',
  paid,
  pending,
  loading = false,
  emphasis = 'total',
  pendingSlot,
  className = '',
}: {
  totals: OrderTotalsBreakdown | null
  currency?: string
  /** Ya pagado sobre este pedido -- se muestra solo si se pasa. */
  paid?: number
  /** Saldo pendiente; cuando se pasa, es la cifra destacada en vez del total. */
  pending?: number
  loading?: boolean
  emphasis?: 'total' | 'pending'
  /** Reemplaza el valor de la fila destacada -- lo usa el drawer de pago
   * para que el saldo a cobrar sea un campo editable en vez de un número
   * fijo (se puede cobrar parcial). */
  pendingSlot?: ReactNode
  className?: string
}) {
  const { t, language } = useLanguage()

  if (!totals) {
    return (
      <div className={`flex items-center justify-center gap-2 rounded-xl border border-brand-100 bg-brand-50/40 px-3 py-6 text-xs text-brand-400 ${className}`}>
        <Loader2Icon className="size-3.5 animate-spin" /> {t('orders.totals.calculating')}
      </div>
    )
  }

  const highlightValue = emphasis === 'pending' && pending !== undefined ? pending : totals.total
  const highlightLabel = emphasis === 'pending' && pending !== undefined ? t('orders.totals.pending') : t('orders.totals.total')

  return (
    <div className={`rounded-xl border border-brand-100 bg-brand-50/40 px-3 py-2.5 text-xs ${className}`}>
      <div className={`space-y-1 transition-opacity ${loading ? 'opacity-50' : ''}`}>
        {/* Base gravable = precio sin impuesto. Con impuestos apagados en el
            tenant no hay nada que discriminar, así que se muestra el bruto
            como "Subtotal" y listo (mismo criterio que OrderDetail.tsx). */}
        {totals.tax_lines.length > 0 ? (
          <Row label={t('orders.totals.taxableBase')} value={formatCurrency(totals.taxable_base, currency)} />
        ) : (
          <Row label={t('orders.totals.subtotal')} value={formatCurrency(totals.subtotal, currency)} />
        )}

        {totals.discount_total > 0 && (
          <Row label={t('orders.totals.discounts')} value={`-${formatCurrency(totals.discount_total, currency)}`} accent="positive" />
        )}

        {totals.tax_lines.map((line) => (
          <Row
            key={`${line.tax_type_code ?? ''}:${line.tax_rate}`}
            label={t('orders.totals.taxLine', {
              name: TAX_TYPE_SHORT_NAME[line.tax_type_code ?? ''] ?? t('orders.totals.genericTax'),
              rate: new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CO', { maximumFractionDigits: 2 }).format(line.tax_rate),
            })}
            value={formatCurrency(line.amount, currency)}
          />
        ))}

        {/* Pedidos viejos (anteriores al fix del 2026-09-03) tienen tax_total
            en la cabecera pero sus líneas quedaron con impuesto 0, así que no
            hay tarifas que discriminar -- se muestra el impuesto como una
            línea genérica en vez de dejar un total que no cuadra con lo de
            arriba. */}
        {totals.tax_lines.length === 0 && totals.tax_total > 0 && (
          <Row label={t('orders.totals.genericTax')} value={formatCurrency(totals.tax_total, currency)} />
        )}

        {totals.shipping > 0 && <Row label={t('orders.totals.shipping')} value={formatCurrency(totals.shipping, currency)} />}

        <div className="!mt-2 flex items-center justify-between gap-3 border-t border-brand-100 pt-2">
          <span className="text-sm font-semibold text-brand-800">{highlightLabel}</span>
          {pendingSlot ?? <span className="text-lg font-bold tabular-nums text-brand-800">{formatCurrency(highlightValue, currency)}</span>}
        </div>

        {/* Ya pagado / total del pedido solo aparecen cuando hay algo que
            aclarar: un pedido con pagos parciales, donde el número grande es
            el saldo y no el total. */}
        {emphasis === 'pending' && pending !== undefined && (totals.total !== pending || (paid ?? 0) > 0) && (
          <div className="!mt-1.5 space-y-1 border-t border-dashed border-brand-100 pt-1.5">
            <Row label={t('orders.totals.orderTotal')} value={formatCurrency(totals.total, currency)} muted />
            {paid !== undefined && paid > 0 && <Row label={t('orders.totals.paid')} value={formatCurrency(paid, currency)} muted />}
          </div>
        )}
      </div>
    </div>
  )
}
