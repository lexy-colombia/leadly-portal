import { useLanguage } from '../../contexts/LanguageContext'
import { PAYMENT_METHOD_LABEL_KEY } from '../../lib/api/orderPayments'
import type { OrderPaymentMethod } from '../../types/domain'
import { CurrencyInput } from './Input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PlusIcon, TrashIcon } from '@/components/atoms/icons'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Una fila de pago en construcción -- método + monto (string, mismo
 * criterio que el resto de inputs de moneda de la app) + lo recibido en
 * efectivo para esa fila puntual (para calcular su vuelto). */
export interface PaymentLineDraft {
  key: string
  method: OrderPaymentMethod
  amount: string
  tendered: string
}

export function createPaymentLine(method: OrderPaymentMethod = 'efectivo', amount = ''): PaymentLineDraft {
  return { key: crypto.randomUUID(), method, amount, tendered: '' }
}

/** Suma de los montos, redondeada -- el helper que cualquier caller usa
 * para validar (Fast Checkout: tiene que dar EXACTO el total; PaymentDrawer:
 * no puede superar el saldo pendiente) sin repetir la cuenta. */
export function sumPaymentLines(lines: PaymentLineDraft[]): number {
  return round2(lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0))
}

/** Vuelto total -- suma del vuelto de cada fila en efectivo (lo normal es
 * que haya una sola, pero nada impide dos montos distintos en efectivo). */
export function sumPaymentLinesChange(lines: PaymentLineDraft[]): number {
  return lines.reduce((sum, l) => (l.method === 'efectivo' ? sum + Math.max(0, (Number(l.tendered) || 0) - (Number(l.amount) || 0)) : sum), 0)
}

/** true si alguna fila en efectivo no tiene un "recibido" suficiente
 * cargado -- mismo candado que ya exigía el formulario de un solo pago. */
export function paymentLinesHaveMissingCash(lines: PaymentLineDraft[]): boolean {
  return lines.some((l) => l.method === 'efectivo' && (l.tendered.trim() === '' || (Number(l.tendered) || 0) < (Number(l.amount) || 0)))
}

/** Editor de una o varias líneas de pago (método + monto), reusado por
 * PosFastCheckout.tsx (venta rápida del POS) y PaymentDrawer.tsx (cuentas
 * abiertas + "Agregar pago" de una orden) -- pedido explícito del usuario
 * 2026-09-11: la primera versión de esto se armó solo adentro de
 * PosFastCheckout, duplicando lo que el drawer de pagos iba a necesitar
 * después. Con UNA sola fila (el caso normal) el monto ni se muestra --
 * mismo comportamiento de siempre, cobrar/pagar el monto completo con un
 * método. Recién con 2+ filas aparece el monto de cada una, editable.
 *
 * Deliberadamente NO sabe nada de "cuánto debería sumar en total" -- Fast
 * Checkout exige que la suma dé EXACTO el total de la venta (no hay
 * concepto de saldo pendiente ahí), mientras que PaymentDrawer permite
 * menos (un pago parcial contra el saldo pendiente de la orden) -- cada
 * caller valida eso con `sumPaymentLines` y pinta su propio mensaje/
 * candado de "Cobrar" según su propia regla. */
export function PaymentLinesEditor({
  lines,
  onChange,
  availableMethods,
  currency = 'COP',
  showAmountAlways = false,
  totalTarget,
  storeCreditBalance,
}: {
  lines: PaymentLineDraft[]
  onChange: (lines: PaymentLineDraft[]) => void
  /** Ya filtrado por el caller -- 'wompi' nunca se ofrece (solo lo
   * registra el webhook), 'credito' solo si el cliente lo tiene
   * habilitado, 'saldo_favor' solo si tiene saldo real. Mismo criterio en
   * los dos lugares que usan este componente, pero el filtro depende de
   * datos que cada caller ya tiene cargados (el cliente elegido), así que
   * vive ahí, no acá. */
  availableMethods: OrderPaymentMethod[]
  currency?: string
  /** Diferencia real entre los dos usos: Fast Checkout SIEMPRE cobra el
   * 100% del total (con una sola línea, el monto ni se muestra -- no hay
   * nada que decidir); PaymentDrawer permite pago PARCIAL incluso con un
   * solo método (el cajero puede tipear menos que el saldo pendiente), así
   * que ahí el monto tiene que ser editable aunque haya una sola línea. */
  showAmountAlways?: boolean
  /** Tope duro de la suma de todas las líneas -- Fast Checkout pasa el
   * total exacto de la venta, PaymentDrawer pasa el saldo pendiente del
   * pedido. Pedido explícito del usuario 2026-09-11 (se había perdido al
   * partir el pago en varias líneas): mientras se tipea, ningún monto se
   * deja superar el remanente disponible (se recorta al tope en el
   * momento, mismo criterio que el viejo campo único), y una línea nueva
   * arranca con lo que sobra hasta ahora en vez de vacía. Opcional -- sin
   * esto el componente queda sin tope, como antes de este ajuste. */
  totalTarget?: number
  /** Tope adicional para las líneas en 'saldo_favor' -- nunca puede superar
   * lo que el cliente tiene a favor, sumado entre todas las filas que usen
   * ese método. Solo tiene efecto si `totalTarget` también se pasa. */
  storeCreditBalance?: number
}) {
  const { t } = useLanguage()
  const isSplit = lines.length > 1
  const showAmount = showAmountAlways || isSplit

  /** Recorta `next.amount` para que, sumado a lo que YA tienen las demás
   * líneas, nunca supere `totalTarget` -- y, si el método es 'saldo_favor',
   * tampoco supere `storeCreditBalance` sumado entre esas líneas. Se aplica
   * en cada edición (monto tipeado o método cambiado) para que cambiar a un
   * método más restrictivo también recorte lo que ya estaba cargado. */
  function clampAmount(next: PaymentLineDraft, key: string): PaymentLineDraft {
    if (totalTarget === undefined) return next
    const amount = Number(next.amount) || 0
    if (amount <= 0) return next
    const othersSum = lines.filter((l) => l.key !== key).reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
    let cap = totalTarget - othersSum
    if (next.method === 'saldo_favor' && storeCreditBalance !== undefined) {
      const othersSaldoFavor = lines.filter((l) => l.key !== key && l.method === 'saldo_favor').reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
      cap = Math.min(cap, storeCreditBalance - othersSaldoFavor)
    }
    cap = round2(Math.max(0, cap))
    return amount > cap ? { ...next, amount: cap > 0 ? String(cap) : '' } : next
  }

  function updateLine(key: string, patch: Partial<PaymentLineDraft>) {
    onChange(lines.map((l) => (l.key === key ? clampAmount({ ...l, ...patch }, key) : l)))
  }

  function removeLine(key: string) {
    if (lines.length <= 1) return
    onChange(lines.filter((l) => l.key !== key))
  }

  function addLine() {
    // La fila nueva arranca con el remanente hasta ahora asignado -- buen
    // punto de partida para el caso más común (dos métodos): el cajero
    // recorta la primera línea y acá aparece automáticamente lo que falta,
    // en vez de tener que calcularlo y tipearlo a mano. Y con un método
    // distinto al de la última fila cuando hay opciones, para no repetir el
    // mismo método dos veces por default.
    const usedMethods = new Set(lines.map((l) => l.method))
    const nextMethod = availableMethods.find((m) => !usedMethods.has(m)) ?? availableMethods[0] ?? 'efectivo'
    const remaining = totalTarget !== undefined ? round2(Math.max(0, totalTarget - sumPaymentLines(lines))) : 0
    onChange([...lines, createPaymentLine(nextMethod, remaining > 0 ? String(remaining) : '')])
  }

  return (
    <div>
      <div className="space-y-2">
        {lines.map((line) => {
          const amount = Number(line.amount) || 0
          const tendered = Number(line.tendered) || 0
          const change = Math.max(0, tendered - amount)
          const insufficientCash = line.method === 'efectivo' && line.tendered.trim() !== '' && tendered < amount
          return (
            <div key={line.key} className={isSplit ? 'rounded-lg border border-brand-100 p-2.5' : ''}>
              <div className="flex items-center gap-1.5">
                <Select value={line.method} onValueChange={(v) => updateLine(line.key, { method: v as OrderPaymentMethod })}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableMethods.map((m) => (
                      <SelectItem key={m} value={m}>
                        {t(PAYMENT_METHOD_LABEL_KEY[m])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {showAmount && (
                  <CurrencyInput
                    value={line.amount}
                    onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                    className="h-9 w-28 shrink-0 text-right text-xs"
                  />
                )}
                {isSplit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    onClick={() => removeLine(line.key)}
                    aria-label={t('pos.payment.removeMethod')}
                    title={t('pos.payment.removeMethod')}
                  >
                    <TrashIcon width={12} height={12} />
                  </Button>
                )}
              </div>

              {line.method === 'efectivo' && (
                <div className="mt-1.5 space-y-1">
                  <label className="block text-xs font-medium text-brand-500">{t('pos.payment.tendered')}</label>
                  <CurrencyInput value={line.tendered} onChange={(e) => updateLine(line.key, { tendered: e.target.value })} className="h-9 text-right text-xs" />
                  {insufficientCash && <p className="text-xs font-medium text-red-600">{t('pos.payment.insufficient')}</p>}
                  {!insufficientCash && change > 0 && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-brand-500">{t('pos.payment.change')}</span>
                      <span className="font-semibold text-emerald-600">{formatCurrency(change, currency)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button type="button" onClick={addLine} className="mt-2 flex items-center gap-1 text-xs font-medium text-accent-600 hover:text-accent-700">
        <PlusIcon width={12} height={12} /> {t('pos.payment.addMethod')}
      </button>
    </div>
  )
}
