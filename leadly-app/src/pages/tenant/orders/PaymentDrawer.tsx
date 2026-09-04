import { useEffect, useState, type FormEvent } from 'react'
import { createPayment, createWompiPaymentLink, PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import { getOrderTotalsBreakdown, type OrderTotalsBreakdown } from '../../../lib/api/orders'
import { getPaymentCredentialStatus } from '../../../lib/api/billing'
import type { OrderPaymentMethod, SalesOrder } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { CurrencyInput, OrderTotalsSummary } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Copy } from 'lucide-react'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Creation only -- a payment logged by mistake is deleted and re-created
 * from OrderDetail.tsx, never edited in place (see the plan's reasoning:
 * keeps this consistent with the rest of the CRM's "simple by default"
 * criterion instead of adding an edit path nothing else needs yet). */
export function PaymentDrawer({
  open,
  onClose,
  tenantId,
  order,
  totals: totalsProp,
  currency = 'COP',
  createOrder,
  creditEnabled,
  storeCreditBalance,
  pendingAmount,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** El pedido completo, no solo su id: el resumen muestra el desglose real
   * que guardó el servidor (base gravable, impuesto por tarifa, envío,
   * total). `null` cuando todavía no existe -- ver `createOrder`. */
  order: SalesOrder | null
  /** Desglose a mostrar cuando el pedido todavía no existe (lo pasa el POS
   * con el preview de la cuenta). Con `order`, se carga solo de
   * sales_order_items y este prop se ignora. */
  totals?: OrderTotalsBreakdown | null
  /** Moneda cuando no hay pedido del que sacarla. */
  currency?: string
  /** Crea (y confirma) el pedido en el momento de registrar el pago, para
   * los flujos donde cobrar es UNA sola acción del usuario -- POS, cuentas
   * abiertas. Antes el pedido se creaba al abrir este drawer: si el cajero
   * lo cerraba sin registrar nada, la venta ya estaba hecha y la cuenta
   * había perdido sus productos (bug reportado 2026-09-04). Ahora abrir el
   * drawer no escribe nada: recién al guardar se crea el pedido y, acto
   * seguido, su pago. */
  createOrder?: () => Promise<SalesOrder>
  /** Only clients with clients.credit_enabled can be charged to their
   * credit account -- 'credito' is hidden from the method select
   * otherwise (also enforced server-side, see apply_credit_payment_charge). */
  creditEnabled: boolean
  /** sum(store_credit_grants) - sum(store_credit_redemptions) for this
   * order's client -- 'saldo_favor' only shows up as a method when this is
   * > 0, and a payment with that method can never exceed it (also
   * enforced server-side, see apply_store_credit_redemption()). */
  storeCreditBalance: number
  /** order.total - sum(existing payments) -- pre-fills the amount field
   * (explicit user request: the form should always open with the balance
   * still owed, not blank) and caps how much a single payment can be for
   * (a sale can't end up "overpaid"). */
  pendingAmount: number
  /** Recibe el pedido que se acaba de cobrar (el existente, o el que
   * `createOrder` acaba de crear) -- así el caller puede, por ejemplo,
   * disparar la impresión del ticket sin tener que volver a resolverlo. */
  onSaved: (order: SalesOrder) => void
}) {
  const { t } = useLanguage()
  const currencyCode = order?.currency ?? currency
  const [method, setMethod] = useState<OrderPaymentMethod>('efectivo')
  const [amount, setAmount] = useState('')
  // Solo efectivo: cuánto entregó el cliente, para poder decirle al cajero
  // el vuelto. No es el monto del pago (ese sigue siendo `amount`) -- queda
  // registrado en las notas, mismo formato que usa pos-checkout para la
  // venta rápida.
  const [tendered, setTendered] = useState('')
  const [paidAt, setPaidAt] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Wompi: only offered once the tenant's own account is fully connected
  // (same "Conectado" criterion as WompiIntegrationDrawer -- a credential
  // row with empty secrets doesn't count). Independent from the manual
  // form below: generating a link doesn't record a payment by itself, only
  // payment-webhook-wompi does that once the customer actually pays.
  const [wompiConnected, setWompiConnected] = useState(false)
  const [wompiLink, setWompiLink] = useState<{ checkoutUrl: string; amount: number } | null>(null)
  const [wompiGenerating, setWompiGenerating] = useState(false)
  const [wompiError, setWompiError] = useState<string | null>(null)
  const [wompiCopied, setWompiCopied] = useState(false)

  // Desglose del pedido tal como lo guardó el servidor -- se relee cada vez
  // que se abre el drawer porque el pedido pudo cambiar entre aperturas
  // (una línea más, un envío distinto).
  const [totals, setTotals] = useState<OrderTotalsBreakdown | null>(null)

  useEffect(() => {
    if (!open) return
    setMethod('efectivo')
    setAmount(pendingAmount > 0 ? String(pendingAmount) : '')
    setTendered('')
    setPaidAt(new Date().toISOString().slice(0, 10))
    setNotes('')
    setTouched(false)
    setFormError(null)
    setWompiLink(null)
    setWompiError(null)
    setWompiCopied(false)
    if (!order) {
      // Todavía no hay pedido (POS): el desglose ya viene calculado por el
      // servidor desde el caller, no hay nada que consultar.
      setTotals(totalsProp ?? null)
      setWompiConnected(false)
      return
    }
    // Se pinta al instante con lo que la cabecera del pedido ya trae (el
    // objeto `order` viene cargado), y se reemplaza por el desglose completo
    // -- cada impuesto con su tarifa, que sale de sales_order_items -- en
    // cuanto llega. Así el modal nunca abre con un spinner.
    setTotals({
      tax_enabled: order.tax_total > 0,
      subtotal: order.subtotal,
      discount_total: order.discount_total,
      taxable_base: order.subtotal - order.discount_total - order.tax_total,
      tax_total: order.tax_total,
      shipping: order.shipping,
      total: order.total,
      tax_lines: [],
    })
    getOrderTotalsBreakdown(order)
      .then(setTotals)
      .catch(() => setFormError(t('orders.paymentDrawer.errors.totals')))
    getPaymentCredentialStatus(tenantId)
      .then((status) => setWompiConnected(status.configuredSecrets.includes('private_key') && status.configuredSecrets.includes('events_key')))
      .catch(() => setWompiConnected(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function handleGenerateWompiLink() {
    setWompiGenerating(true)
    setWompiError(null)
    try {
      const result = await createWompiPaymentLink(order!.id)
      setWompiLink({ checkoutUrl: result.checkoutUrl, amount: result.amount })
    } catch (err) {
      setWompiError(err instanceof Error ? err.message : t('orders.paymentDrawer.wompi.errors.generate'))
    } finally {
      setWompiGenerating(false)
    }
  }

  async function handleCopyWompiLink() {
    if (!wompiLink) return
    await navigator.clipboard.writeText(wompiLink.checkoutUrl)
    setWompiCopied(true)
    setTimeout(() => setWompiCopied(false), 2000)
  }

  const amountValue = Number(amount)
  // Vuelto = lo recibido menos lo que se está cobrando. Solo aplica a
  // efectivo (una transferencia o una tarjeta se cobran por el monto
  // exacto), y solo se muestra una vez que el cajero tipeó algo.
  const tenderedValue = Number(tendered) || 0
  const showCashFields = method === 'efectivo'
  const changeDue = showCashFields && tendered.trim() !== '' ? tenderedValue - amountValue : null
  // 'saldo_favor' has a second, tighter cap on top of pendingAmount -- can
  // never redeem more store credit than the client actually has.
  const maxAmount = method === 'saldo_favor' ? Math.min(pendingAmount, storeCreditBalance) : pendingAmount

  /** Nunca se puede tipear más que el saldo pendiente (o que el saldo a
   * favor disponible, si el método es ese) -- el valor se recorta al tope
   * en el momento, en vez de dejar registrar de más. */
  function handleAmountChange(next: string) {
    if (next === '') {
      setAmount('')
      return
    }
    const parsed = Number(next)
    if (!Number.isFinite(parsed)) return
    setAmount(parsed > maxAmount ? String(maxAmount) : next)
  }


  // Re-clamps the prefilled amount when switching into a method with a
  // lower cap (e.g. pendingAmount is bigger than the client's store
  // credit) -- otherwise the field silently opens already over the limit.
  useEffect(() => {
    if (Number(amount) > maxAmount) setAmount(maxAmount > 0 ? String(maxAmount) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method])
  const amountError = touched
    ? !(amountValue > 0)
      ? t('orders.paymentDrawer.errors.amountInvalid')
      : amountValue > maxAmount
        ? t('orders.paymentDrawer.errors.amountExceedsBalance', { amount: formatCurrency(maxAmount, currencyCode) })
        : undefined
    : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(amountValue > 0) || amountValue > maxAmount) return

    setSubmitting(true)
    try {
      // El recibido/vuelto queda en las notas del pago, mismo formato que
      // deja pos-checkout en la venta rápida (sales_order_payments no tiene
      // columnas propias para esto y no hacía falta inventarlas: es
      // información del momento del cobro, no un dato con vida propia).
      const cashNote = showCashFields && tendered.trim() !== '' ? t('orders.paymentDrawer.cash.note', { tendered: formatCurrency(tenderedValue, currencyCode), change: formatCurrency(Math.max(0, changeDue ?? 0), currencyCode) }) : null
      const finalNotes = [cashNote, notes.trim() || null].filter(Boolean).join(' · ') || null

      // Acá es donde el cobro se hace real: si el pedido todavía no existe
      // (POS), se crea y confirma recién ahora -- cerrar este drawer sin
      // guardar no deja nada hecho.
      const target = order ?? (createOrder ? await createOrder() : null)
      if (!target) throw new Error(t('orders.paymentDrawer.errors.save'))

      await createPayment({
        tenant_id: tenantId,
        order_id: target.id,
        method,
        amount: amountValue,
        paid_at: paidAt || undefined,
        notes: finalNotes,
      })
      onSaved(target)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('orders.paymentDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('orders.paymentDrawer.title')} description={t('orders.paymentDrawer.description')}>
      {/* Fecha primero, después el resumen: es un dato del cobro, no del
          pedido, y arriba se responde de una "¿cuándo?" antes de entrar en
          "¿cuánto?". */}
      <div className="mb-4">
        <Label htmlFor="payment-date">{t('orders.paymentDrawer.fields.date')}</Label>
        <Input id="payment-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="mt-1" />
      </div>

      <div className="mb-4">
        <Label htmlFor="payment-method">{t('orders.paymentDrawer.fields.method')}</Label>
        <Select value={method} onValueChange={(v) => setMethod(v as OrderPaymentMethod)}>
          <SelectTrigger id="payment-method" className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[])
              // 'wompi' never shows here -- it's only ever recorded
              // automatically by payment-webhook-wompi once a customer
              // actually pays a generated link (see the section above),
              // never picked and typed in manually.
              .filter((m) => m !== 'wompi' && (m !== 'credito' || creditEnabled) && (m !== 'saldo_favor' || storeCreditBalance > 0))
              .map((m) => (
                <SelectItem key={m} value={m}>
                  {t(PAYMENT_METHOD_LABEL_KEY[m])}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      {/* Qué se está cobrando -- el desglose real (base gravable, cada
          impuesto con su tarifa, envío) sale de sales_order_items, nunca de
          una cuenta hecha acá. El saldo a cobrar es editable en el propio
          resumen (se puede cobrar parcial) y está topado al pendiente: no
          hay forma de tipear de más. */}
      <div className="mb-4">
        <p className="mb-1.5 text-xs font-semibold tracking-wide text-brand-500 uppercase">{t('orders.paymentDrawer.summaryTitle')}</p>
        <OrderTotalsSummary
          totals={totals}
          currency={currencyCode}
          paid={order ? order.total - pendingAmount : 0}
          pending={pendingAmount}
          emphasis="pending"
          pendingSlot={
            <CurrencyInput
              id="payment-amount"
              value={amount}
              invalid={!!amountError}
              onChange={(e) => handleAmountChange(e.target.value)}
              aria-label={t('orders.paymentDrawer.fields.amountLabel')}
              className="h-10 w-40 bg-white text-right text-lg font-bold tabular-nums"
            />
          }
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <FieldError message={amountError} />
          {amountValue !== maxAmount && maxAmount > 0 && (
            <button
              type="button"
              onClick={() => setAmount(String(maxAmount))}
              className="ml-auto rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-700 transition-colors hover:bg-accent-100"
            >
              {t('orders.paymentDrawer.fields.payFull')}
            </button>
          )}
        </div>
      </div>

      {order && wompiConnected && pendingAmount > 0 && (
        <div className="mb-4 space-y-2 rounded-lg border border-brand-100 bg-brand-50/40 p-3">
          <p className="text-xs font-medium text-brand-700">{t('orders.paymentDrawer.wompi.title')}</p>
          {!wompiLink ? (
            <>
              <p className="text-[11px] text-brand-400">{t('orders.paymentDrawer.wompi.hint', { amount: formatCurrency(pendingAmount, currencyCode) })}</p>
              <Button type="button" variant="secondary" size="sm" onClick={handleGenerateWompiLink} disabled={wompiGenerating}>
                {wompiGenerating ? t('orders.paymentDrawer.wompi.generating') : t('orders.paymentDrawer.wompi.generate')}
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Input readOnly value={wompiLink.checkoutUrl} className="flex-1 text-xs" onFocus={(e) => e.target.select()} />
              <Button type="button" variant="secondary" size="icon-sm" onClick={handleCopyWompiLink} aria-label={t('orders.paymentDrawer.wompi.copyAria')}>
                <Copy className="size-3.5" />
              </Button>
            </div>
          )}
          {wompiCopied && <p className="text-[11px] text-emerald-600">{t('orders.paymentDrawer.wompi.copied')}</p>}
          {wompiError && <p className="text-[11px] text-red-600">{wompiError}</p>}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Efectivo: recibido -> vuelto. No aparece con ningún otro método
            (una transferencia o una tarjeta entran por el monto exacto).
            Mismo campo y mismo formato que el saldo a cobrar de arriba. */}
        {showCashFields && (
          <div className="rounded-xl border border-brand-100 bg-brand-50/40 px-3 py-2.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="payment-tendered" className="text-sm font-semibold text-brand-800">
                {t('orders.paymentDrawer.cash.tendered')}
              </Label>
              <CurrencyInput
                id="payment-tendered"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                className="h-10 w-40 bg-white text-right text-lg font-bold tabular-nums"
              />
            </div>
            {changeDue !== null &&
              (changeDue < 0 ? (
                <p className="mt-2 border-t border-brand-100 pt-2 text-xs font-medium text-red-600">{t('orders.paymentDrawer.cash.insufficient')}</p>
              ) : (
                <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-brand-100 pt-2">
                  <span className="text-sm font-semibold text-brand-800">{t('orders.paymentDrawer.cash.change')}</span>
                  <span className="text-lg font-bold tabular-nums text-emerald-600">{formatCurrency(changeDue, currencyCode)}</span>
                </div>
              ))}
          </div>
        )}

        <div>
          <Label htmlFor="payment-notes">{t('orders.paymentDrawer.fields.notes')}</Label>
          <Textarea id="payment-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
