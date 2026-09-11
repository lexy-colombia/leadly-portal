import { useEffect, useState, type FormEvent } from 'react'
import { createPayment, createWompiPaymentLink, PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import { getOrderTotalsBreakdown, type OrderTotalsBreakdown } from '../../../lib/api/orders'
import { getPaymentCredentialStatus } from '../../../lib/api/billing'
import { sendPosInvoiceForOrder } from '../../../lib/api/salesInvoices'
import type { Client, OrderPaymentMethod, SalesOrder } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import {
  OrderTotalsSummary,
  PaymentLinesEditor,
  createPaymentLine,
  sumPaymentLines,
  sumPaymentLinesChange,
  type PaymentLineDraft,
} from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Copy } from 'lucide-react'
import { ClientPickerCard } from '../clients/ClientPickerCard'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Pago dividido (2026-09-11, pedido explícito del usuario): se puede
 * cargar más de un método de pago (ej. parte en efectivo, parte con
 * tarjeta) y registrarlos todos en un solo "Guardar", en vez de guardar
 * uno y tener que reabrir este mismo drawer con "Agregar pago" para cada
 * método siguiente. Editor de filas compartido con PosFastCheckout.tsx
 * (components/molecules/PaymentLinesEditor.tsx) -- a diferencia de ahí,
 * acá el monto SIEMPRE es editable (incluso con una sola línea): este
 * drawer admite pago PARCIAL contra el saldo pendiente, cosa que la venta
 * rápida del POS no tiene (ahí siempre se cobra el 100%).
 *
 * Corregir el MÉTODO de un pago ya registrado (feedback del mismo día:
 * "puede que me equivocara en el método de pago") tiene su propio editor
 * chico en OrderDetail.tsx (`PaymentMethodEditor`) en vez de reusar este
 * drawer -- toda la lógica de acá (montos, Wompi, factura DIAN, creación
 * del pedido) es específica de registrar pagos NUEVOS contra un saldo
 * pendiente, nada de eso aplica a corregir un campo de un pago que ya
 * existe. Corregir el MONTO de un pago ya registrado sigue siendo borrar
 * y volver a crearlo (ver OrderDetail.tsx). */
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
  dianConnected = false,
  defaultBuyer = null,
  onSearchBuyers,
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
  createOrder?: (buyerContactId?: string | null) => Promise<SalesOrder>
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
  /** true solo si el caller ya confirmó que el tenant tiene 'dian_directo'
   * activo (2026-09-08) -- con esto en false/ausente, nada de lo nuevo de
   * facturación se renderiza ni corre: la feature queda 100% inerte para
   * cualquier tenant sin facturación electrónica. */
  dianConnected?: boolean
  /** Comprador ya elegido de la cuenta/pedido -- precarga el selector de
   * "a nombre de quién factura" para que el caso común (facturarle al mismo
   * que ya está en la cuenta) no pida ningún click extra. Solo se usa
   * cuando `order` es null (flujo de creación, POS) -- un pedido ya
   * existente ("Agregar pago") ya tiene comprador fijo, no se puede
   * cambiar acá. */
  defaultBuyer?: Client | null
  /** Fuente de candidatos para el selector de comprador -- mismo callback
   * que ya le pasa el caller a su propio ClientPickerCard (ej.
   * searchPosClients), no se reimplementa la búsqueda acá. */
  onSearchBuyers?: (query: string) => Promise<Client[]>
  /** Recibe el pedido que se acaba de cobrar (el existente, o el que
   * `createOrder` acaba de crear) -- así el caller puede, por ejemplo,
   * disparar la impresión del ticket sin tener que volver a resolverlo.
   * `einvoicing` solo viene definido si se pidió factura electrónica en
   * este cobro: `error` no-nulo significa que la DIAN rechazó o el envío
   * falló -- el pago YA quedó registrado igual (nunca se revierte por
   * esto), es el caller quien decide qué mostrar/qué hacer con ese error. */
  onSaved: (order: SalesOrder, einvoicing?: { attempted: boolean; error: string | null }) => void
}) {
  const { t } = useLanguage()
  const currencyCode = order?.currency ?? currency
  const [paymentLines, setPaymentLines] = useState<PaymentLineDraft[]>([createPaymentLine()])
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

  // Facturación electrónica al cobrar (2026-09-08) -- ver dianConnected.
  // Nunca marcado por default: es una decisión explícita del cajero en
  // cada cobro, no algo que se herede de un cobro anterior.
  const [wantsInvoice, setWantsInvoice] = useState(false)
  const [invoiceBuyer, setInvoiceBuyer] = useState<Client | null>(null)
  const [sendingInvoice, setSendingInvoice] = useState(false)

  useEffect(() => {
    if (!open) return
    setPaymentLines([createPaymentLine('efectivo', pendingAmount > 0 ? String(pendingAmount) : '')])
    setPaidAt(new Date().toISOString().slice(0, 10))
    setNotes('')
    setTouched(false)
    setFormError(null)
    setWompiLink(null)
    setWompiError(null)
    setWompiCopied(false)
    setWantsInvoice(false)
    setInvoiceBuyer(defaultBuyer)
    setSendingInvoice(false)
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

  const assignedTotal = sumPaymentLines(paymentLines)
  const totalChange = sumPaymentLinesChange(paymentLines)
  // A diferencia de PosFastCheckout (donde "recibido" es obligatorio porque
  // se cobra el 100% en el momento), acá "Recibido" es informativo/opcional
  // -- el comportamiento de siempre, antes de este refactor, era poder
  // guardar sin tipearlo. Solo bloquea si el cajero SÍ tipeó un recibido y
  // quedó por debajo del monto (insuficiente de verdad), nunca por dejarlo
  // vacío -- ese caso ya lo señaliza PaymentLinesEditor por fila.
  const insufficientCash = paymentLines.some((l) => l.method === 'efectivo' && l.tendered.trim() !== '' && (Number(l.tendered) || 0) < (Number(l.amount) || 0))
  // 'saldo_favor' nunca puede cubrir más de lo que el cliente tiene a
  // favor -- sumado entre todas las filas que usen ese método (lo normal
  // es que haya una sola).
  const saldoFavorAssigned = paymentLines.filter((l) => l.method === 'saldo_favor').reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
  const storeCreditExceeded = saldoFavorAssigned > storeCreditBalance + 0.01
  const exceedsPending = assignedTotal > pendingAmount + 0.01
  const linesValid = paymentLines.length > 0 && paymentLines.every((l) => (Number(l.amount) || 0) > 0)
  const amountError = touched
    ? !linesValid
      ? t('orders.paymentDrawer.errors.amountInvalid')
      : exceedsPending
        ? t('orders.paymentDrawer.errors.amountExceedsBalance', { amount: formatCurrency(pendingAmount, currencyCode) })
        : storeCreditExceeded
          ? t('orders.paymentDrawer.errors.amountExceedsBalance', { amount: formatCurrency(storeCreditBalance, currencyCode) })
          : undefined
    : undefined

  // 'wompi' nunca se ofrece acá (solo lo registra el webhook al pagar un
  // link generado); 'credito'/'saldo_favor' solo si el cliente califica.
  const availableMethods = (Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[]).filter(
    (m) => m !== 'wompi' && (m !== 'credito' || creditEnabled) && (m !== 'saldo_favor' || storeCreditBalance > 0),
  )

  function handlePayFull() {
    if (paymentLines.length !== 1) return
    const line = paymentLines[0]
    const cap = line.method === 'saldo_favor' ? Math.min(pendingAmount, storeCreditBalance) : pendingAmount
    setPaymentLines([{ ...line, amount: cap > 0 ? String(cap) : '' }])
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!linesValid || exceedsPending || storeCreditExceeded || insufficientCash) return

    setSubmitting(true)
    try {
      // Acá es donde el cobro se hace real: si el pedido todavía no existe
      // (POS), se crea y confirma recién ahora -- cerrar este drawer sin
      // guardar no deja nada hecho.
      const target = order ?? (createOrder ? await createOrder(wantsInvoice ? (invoiceBuyer?.id ?? null) : undefined) : null)
      if (!target) throw new Error(t('orders.paymentDrawer.errors.save'))

      // Inserción SECUENCIAL, no Promise.all: triggers como
      // apply_credit_payment_charge/apply_store_credit_redemption validan
      // el saldo acumulado contra lo ya insertado -- en paralelo, dos filas
      // podrían leer el mismo saldo parcial y las dos pasar el tope.
      for (const [index, line] of paymentLines.entries()) {
        const lineAmount = Number(line.amount) || 0
        // El recibido/vuelto queda en las notas del pago, mismo formato que
        // deja pos-checkout en la venta rápida (sales_order_payments no
        // tiene columnas propias para esto: es información del momento del
        // cobro, no un dato con vida propia). El texto libre del cajero solo
        // va en la primera fila -- no tiene sentido repetirlo en cada una.
        const cashNote =
          line.method === 'efectivo' && line.tendered.trim() !== ''
            ? t('orders.paymentDrawer.cash.note', {
                tendered: formatCurrency(Number(line.tendered) || 0, currencyCode),
                change: formatCurrency(Math.max(0, (Number(line.tendered) || 0) - lineAmount), currencyCode),
              })
            : null
        const finalNotes = [cashNote, index === 0 ? notes.trim() || null : null].filter(Boolean).join(' · ') || null

        await createPayment({
          tenant_id: tenantId,
          order_id: target.id,
          method: line.method,
          amount: lineAmount,
          paid_at: paidAt || undefined,
          notes: finalNotes,
        })
      }

      // Envío a la DIAN, SIEMPRE después del pago -- un rechazo acá nunca
      // revierte el cobro, la plata ya entró independientemente de si el
      // documento fiscal se pudo emitir. Solo se intenta cuando este mismo
      // pago deja el saldo en $0 -- una venta parcial no se factura todavía
      // (mismo candado que ya aplica el servidor, ver dian-submit).
      let einvoicing: { attempted: boolean; error: string | null } | undefined
      if (wantsInvoice && pendingAmount - assignedTotal <= 0) {
        setSendingInvoice(true)
        try {
          // Un rechazo de la DIAN NO es un error HTTP -- dian-submit
          // responde 200 con status:'error' + faultReason (resultado de
          // negocio esperado, no una falla de la llamada), mismo criterio
          // que ya usa OrderDetail.tsx::handleSendInvoice. Sin este chequeo
          // explícito, un rechazo real quedaba tratado como éxito.
          const result = await sendPosInvoiceForOrder(target.id)
          // 'rejected' ya es el veredicto real de la DIAN (el propio envío
          // lo consulta antes de responder, ver sendInvoiceToDian.ts).
          const failureDetail = result.status === 'error' ? result.faultReason : result.status === 'rejected' ? result.rejectionDetail : null
          einvoicing = { attempted: true, error: failureDetail !== null ? failureDetail || t('orders.paymentDrawer.einvoicing.errors.send') : null }
        } catch (err) {
          einvoicing = { attempted: true, error: err instanceof Error ? err.message : t('orders.paymentDrawer.einvoicing.errors.send') }
        } finally {
          setSendingInvoice(false)
        }
      }

      onSaved(target, einvoicing)
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

      {/* Método(s) y monto(s) -- con una sola línea (el caso normal) el
          monto ya viene precargado con el saldo pendiente, sin nada más que
          decidir; "+ Agregar otro método" (dentro del editor) es lo que
          habilita el pago dividido. */}
      <div className="mb-4">
        <Label>{t('orders.paymentDrawer.fields.method')}</Label>
        <div className="mt-1">
          <PaymentLinesEditor
            lines={paymentLines}
            onChange={setPaymentLines}
            availableMethods={availableMethods}
            currency={currencyCode}
            showAmountAlways
            totalTarget={pendingAmount}
            storeCreditBalance={storeCreditBalance}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <FieldError message={amountError} />
          {paymentLines.length === 1 && assignedTotal !== pendingAmount && pendingAmount > 0 && (
            <button
              type="button"
              onClick={handlePayFull}
              className="ml-auto rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-700 transition-colors hover:bg-accent-100"
            >
              {t('orders.paymentDrawer.fields.payFull')}
            </button>
          )}
        </div>
      </div>

      {/* Qué se está cobrando -- el desglose real (base gravable, cada
          impuesto con su tarifa, envío) sale de sales_order_items, nunca de
          una cuenta hecha acá. El saldo pendiente queda de solo lectura acá
          (es editable arriba, en las líneas de pago); con más de una línea
          se suma "Asignado" para que quede claro cuánto de ese saldo ya
          quedó cubierto. */}
      <div className="mb-4">
        <p className="mb-1.5 text-xs font-semibold tracking-wide text-brand-500 uppercase">{t('orders.paymentDrawer.summaryTitle')}</p>
        <OrderTotalsSummary totals={totals} currency={currencyCode} paid={order ? order.total - pendingAmount : 0} pending={pendingAmount} emphasis="pending" />
        {paymentLines.length > 1 && (
          <div className="mt-1.5 flex items-center justify-between px-1 text-xs">
            <span className="font-medium text-brand-500">{t('pos.payment.assigned')}</span>
            <span className={`font-semibold tabular-nums ${exceedsPending ? 'text-red-600' : 'text-brand-800'}`}>
              {formatCurrency(assignedTotal, currencyCode)} / {formatCurrency(pendingAmount, currencyCode)}
            </span>
          </div>
        )}
      </div>

      {/* Facturación electrónica DIAN al cobrar (2026-09-08) -- solo
          existe si el caller ya confirmó que el tenant tiene DIAN
          conectada. El selector de comprador solo aplica al flujo de
          creación (POS): un pedido ya existente ("Agregar pago") ya tiene
          su comprador fijo desde que se creó. */}
      {dianConnected && (
        <div className="mb-4 rounded-xl border border-brand-100 bg-brand-50/40 p-3">
          <div className="flex items-center gap-2">
            <Checkbox id="payment-generate-invoice" checked={wantsInvoice} onCheckedChange={(v) => setWantsInvoice(!!v)} />
            <Label htmlFor="payment-generate-invoice" className="text-xs font-semibold text-brand-800">
              {t('orders.paymentDrawer.einvoicing.checkbox')}
            </Label>
          </div>
          {wantsInvoice && !order && (
            <div className="mt-2">
              <ClientPickerCard
                tenantId={tenantId}
                client={invoiceBuyer}
                onSelect={setInvoiceBuyer}
                onSearch={onSearchBuyers ?? (async () => [])}
                emptyLabel={t('pos.customer.walkIn')}
                allowClear
                clearActionLabel={t('pos.customer.useWalkIn')}
                bare
              />
              {invoiceBuyer && (!invoiceBuyer.dian_document_type_code || !invoiceBuyer.document_number) && (
                <p className="mt-1 text-[11px] text-amber-700">{t('orders.paymentDrawer.einvoicing.missingDocWarning')}</p>
              )}
            </div>
          )}
        </div>
      )}

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
        {/* Vuelto total (suma del vuelto de cada línea en efectivo) -- ya lo
            resuelve PaymentLinesEditor por fila, esto es solo un resumen
            cuando hay más de un método involucrado. */}
        {paymentLines.length > 1 && totalChange > 0 && (
          <div className="flex items-baseline justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/40 px-3 py-2.5 text-xs">
            <span className="font-semibold text-brand-800">{t('orders.paymentDrawer.cash.change')}</span>
            <span className="font-bold tabular-nums text-emerald-600">{formatCurrency(totalChange, currencyCode)}</span>
          </div>
        )}

        <div>
          <Label htmlFor="payment-notes">{t('orders.paymentDrawer.fields.notes')}</Label>
          <Textarea id="payment-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" disabled={submitting}>
            {sendingInvoice ? t('orders.paymentDrawer.einvoicing.sending') : submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
