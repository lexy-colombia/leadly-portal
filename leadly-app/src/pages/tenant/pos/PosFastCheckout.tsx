import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckIcon, PackageIcon, SearchIcon, XIcon } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'
import { useLanguage } from '../../../contexts/LanguageContext'
import { getWalkInClient, lookupPosBarcode, posCheckout, searchPosClients, searchPosProducts, type PosCheckoutResult, type PosPaymentMethod, type PosProduct, type PosVariantOption } from '../../../lib/api/pos'
import { PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import type { OrderItemInput, OrderTotalsBreakdown } from '../../../lib/api/orders'
import { useOrderTotalsPreview } from '../../../lib/useOrderTotalsPreview'
import { usePosReceiptPrinter } from '../../../lib/usePosReceiptPrinter'
import { getClientCreditSummary } from '../../../lib/api/credit'
import { getStoreCreditBalance } from '../../../lib/api/returns'
import type { Client, OrderPaymentMethod } from '../../../types/domain'
import { PageSpinner } from '@/components/atoms'
import {
  OrderTotalsSummary,
  ProductSearchBox,
  ProductSearchResultRow,
  QuantityStepper,
  PaymentLinesEditor,
  createPaymentLine,
  sumPaymentLines,
  sumPaymentLinesChange,
  paymentLinesHaveMissingCash,
  type PaymentLineDraft,
} from '@/components/molecules'
import { PrinterIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TrashIcon } from '@/components/atoms/icons'
import { ClientPickerCard } from '../clients/ClientPickerCard'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

interface CartLine {
  product_id: string
  variant_id: string | null
  name: string
  variantLabel: string | null
  sku: string | null
  price: number
  quantity: number
  available: number | null
}

function lineKey(l: Pick<CartLine, 'product_id' | 'variant_id'>): string {
  return `${l.product_id}:${l.variant_id ?? ''}`
}

/** Punto de venta de mostrador -- escanear/buscar, armar el carrito en
 * memoria (sin autosave: acá no hay borrador que persistir a mitad de
 * venta, a diferencia de Órdenes/cuentas abiertas), cobrar en una sola
 * llamada a `pos-checkout` (crea el pedido, lo confirma con chequeo de
 * stock real, y registra el pago), y mostrar la confirmación. Sin
 * direcciones, sin despacho, sin envío a la DIAN todavía. Modo por
 * default de /app/pos -- cuando el tenant activa `pos_allow_open_tabs`,
 * Pos.tsx renderiza PosOpenTabs en su lugar y este componente no se toca. */
export function PosFastCheckout() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const tenantId = profile?.tenant_id ?? null
  const receiptPrinter = usePosReceiptPrinter(tenantId)

  const [walkIn, setWalkIn] = useState<Client | null>(null)
  const [cart, setCart] = useState<CartLine[]>([])
  // Idempotencia del cobro: un mismo uuid por intento de venta, reenviado
  // tal cual en cada reintento de "Cobrar" -- así un click repetido tras un
  // error nunca crea una cotización/venta duplicada (bug real reportado:
  // ver comentario de cabecera de pos-checkout). Se regenera recién al
  // arrancar una venta nueva (resetForNewSale), nunca en cada click.
  const checkoutTokenRef = useRef(crypto.randomUUID())

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<PosProduct[]>([])
  const [scanError, setScanError] = useState<string | null>(null)
  const [variantPickerFor, setVariantPickerFor] = useState<PosProduct | null>(null)
  const [variantPickerQty, setVariantPickerQty] = useState(1)
  const scanInputRef = useRef<HTMLInputElement>(null)

  const [customer, setCustomer] = useState<Client | null>(null)
  // Igual que OrderDetail.tsx: 'credito' solo se ofrece si el cliente tiene
  // credit_enabled, 'saldo_favor' solo si tiene saldo a favor real -- se
  // resuelve apenas se elige un cliente real (el consumidor final nunca
  // tiene ninguno de los dos).
  const [creditBalance, setCreditBalance] = useState(0)
  const [storeCreditBalance, setStoreCreditBalance] = useState(0)

  // Una o varias líneas de pago -- por default hay una sola (cobrar el
  // total completo con un método), y su monto se mantiene sincronizado con
  // el total del carrito en silencio mientras sea la única (ver el
  // useEffect más abajo, junto a `total`). Pedido explícito del usuario
  // (2026-09-11): "si en una cuenta me dan varios pagos, me toca darle
  // clic al pedido y volver a agregar los otros" -- con más de una fila,
  // el cajero reparte el total entre varios métodos ANTES de cobrar, en
  // una sola llamada a pos-checkout. Editor compartido con PaymentDrawer.tsx
  // (components/molecules/PaymentLinesEditor.tsx) -- ver el comentario de
  // cabecera de ese archivo.
  const [paymentLines, setPaymentLines] = useState<PaymentLineDraft[]>([createPaymentLine()])
  const [charging, setCharging] = useState(false)
  const [chargeError, setChargeError] = useState<string | null>(null)
  const [result, setResult] = useState<PosCheckoutResult | null>(null)

  useEffect(() => {
    if (!tenantId) return
    getWalkInClient(tenantId).then(setWalkIn).catch(() => setWalkIn(null))
  }, [tenantId])

  // El input de escaneo se mantiene enfocado todo el tiempo -- un lector
  // USB/Bluetooth es, para el navegador, un teclado que tipea rápido y
  // manda Enter solo; si el foco se pierde (un click en el carrito, por
  // ejemplo) el próximo escaneo no llega a ningún lado.
  useEffect(() => {
    if (!result && !variantPickerFor) scanInputRef.current?.focus()
  }, [result, variantPickerFor])

  useEffect(() => {
    if (!tenantId || query.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      searchPosProducts(tenantId, query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [tenantId, query])

  useEffect(() => {
    if (!customer) {
      setCreditBalance(0)
      setStoreCreditBalance(0)
      return
    }
    getStoreCreditBalance(customer.id)
      .then(setStoreCreditBalance)
      .catch(() => setStoreCreditBalance(0))
    if (customer.credit_enabled) {
      getClientCreditSummary(customer)
        .then((s) => setCreditBalance(s.balance))
        .catch(() => setCreditBalance(0))
    } else {
      setCreditBalance(0)
    }
  }, [customer])

  // Si el método elegido en CUALQUIER fila deja de estar disponible (se
  // cambió a un cliente sin crédito, o al consumidor final) esa fila
  // vuelve a efectivo -- nunca se manda un método que ya no aparece en el
  // select.
  useEffect(() => {
    setPaymentLines((prev) =>
      prev.map((l) => {
        if (l.method === 'credito' && !customer?.credit_enabled) return { ...l, method: 'efectivo' }
        if (l.method === 'saldo_favor' && storeCreditBalance <= 0) return { ...l, method: 'efectivo' }
        return l
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, storeCreditBalance])

  // Alta libre, sin ningún chequeo acá -- pedido explícito del usuario
  // 2026-09-06: "no debo hacer validaciones en front de nada en estos
  // componentes de pos". El único chequeo de stock real es el que devuelve
  // el servidor (stock_shortfalls, ver useOrderTotalsPreview más abajo),
  // que resalta la línea en rojo y deshabilita "Cobrar" -- nunca se decide
  // acá si algo se puede o no se puede agregar.
  function addToCart(product: PosProduct, variant: PosVariantOption | null, qty = 1) {
    const key = lineKey({ product_id: product.id, variant_id: variant?.id ?? null })
    setCart((prev) => {
      const existing = prev.find((l) => lineKey(l) === key)
      if (existing) return prev.map((l) => (lineKey(l) === key ? { ...l, quantity: l.quantity + qty } : l))
      return [
        ...prev,
        {
          product_id: product.id,
          variant_id: variant?.id ?? null,
          name: product.name,
          variantLabel: variant?.label ?? null,
          sku: variant?.sku ?? product.sku,
          price: variant?.price ?? product.price,
          quantity: qty,
          available: variant?.available ?? product.available,
        },
      ]
    })
  }

  function handlePick(product: PosProduct, quantity = 1) {
    if (product.has_variants) {
      setVariantPickerFor(product)
      setVariantPickerQty(quantity)
    } else {
      addToCart(product, null, quantity)
    }
    setQuery('')
    setResults([])
    setScanError(null)
  }

  async function handleScanSubmit() {
    const code = query.trim()
    if (!code || !tenantId) return
    setScanError(null)
    setSearching(true)
    try {
      const match = await lookupPosBarcode(tenantId, code)
      if (!match) {
        setScanError(t('pos.scan.notFound', { code }))
        return
      }
      if (match.variant) {
        addToCart(match.product, match.variant)
        setQuery('')
        setResults([])
      } else if (match.product.has_variants) {
        setVariantPickerFor(match.product)
        setVariantPickerQty(1)
        setQuery('')
        setResults([])
      } else {
        addToCart(match.product, null)
        setQuery('')
        setResults([])
      }
    } finally {
      setSearching(false)
    }
  }

  function updateQuantity(key: string, quantity: number) {
    if (quantity <= 0) {
      setCart((prev) => prev.filter((l) => lineKey(l) !== key))
      return
    }
    setCart((prev) => prev.map((l) => (lineKey(l) === key ? { ...l, quantity } : l)))
  }

  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => lineKey(l) !== key))
  }

  // Desglose completo (base gravable, impuesto por tarifa, total) resuelto
  // por el servidor a partir de las líneas del carrito -- el impuesto de
  // cada producto sale de la tabla `products` real, no de nada que este
  // componente sepa. Ver useOrderTotalsPreview.
  const previewItems: OrderItemInput[] = cart.map((l) => ({
    product_id: l.product_id,
    variant_id: l.variant_id,
    warehouse_id: null,
    product_name: l.name,
    sku: l.sku,
    quantity: l.quantity,
    unit_price: l.price,
    discount_amount: 0,
  }))
  const { totals, stockShortfalls, loading: totalsLoading, error: totalsError } = useOrderTotalsPreview(previewItems)

  // Mientras el desglose viaja (o si falla), el botón de cobrar y el vuelto
  // siguen funcionando con la suma de las líneas: el total no depende del
  // impuesto (está incluido en el precio), solo su reparto entre base e
  // impuesto -- que es justo lo que se espera del servidor.
  const total = totals?.total ?? cart.reduce((sum, l) => sum + l.price * l.quantity, 0)

  // Mientras haya una sola fila de pago, su monto es siempre el total del
  // carrito -- ni se muestra el campo ni el cajero lo toca, mismo
  // comportamiento de siempre. Recién al "dividir el pago" (agregar una
  // segunda fila) el monto de cada una pasa a ser editable.
  useEffect(() => {
    setPaymentLines((prev) => (prev.length === 1 ? [{ ...prev[0], amount: String(total) }] : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total])

  const isSplitPayment = paymentLines.length > 1
  const assignedTotal = sumPaymentLines(paymentLines)
  const remainingToAssign = round2(total - assignedTotal)
  const totalChange = sumPaymentLinesChange(paymentLines)
  // 'saldo_favor' nunca puede cubrir más de lo que el cliente tiene a favor
  // -- mismo tope que PaymentDrawer.tsx, sumado entre todas las filas que
  // usen ese método (lo normal es que haya una sola, pero se suma por las
  // dudas en vez de asumirlo).
  const saldoFavorAssigned = paymentLines.filter((l) => l.method === 'saldo_favor').reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
  const storeCreditExceeded = saldoFavorAssigned > storeCreditBalance
  const canCharge =
    cart.length > 0 &&
    !charging &&
    !storeCreditExceeded &&
    stockShortfalls.length === 0 &&
    Math.abs(remainingToAssign) < 0.01 &&
    paymentLines.every((l) => (Number(l.amount) || 0) > 0) &&
    !paymentLinesHaveMissingCash(paymentLines)

  async function handleCharge() {
    if (cart.length === 0) {
      setChargeError(t('pos.errors.emptyCart'))
      return
    }
    setCharging(true)
    setChargeError(null)
    try {
      const response = await posCheckout({
        contact_id: customer?.id ?? null,
        items: cart.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, quantity: l.quantity })),
        // El cast es seguro: `availableMethods` (lo que de verdad se le
        // ofrece al cajero en el Select) nunca incluye 'wompi' -- ver más
        // abajo, mismo filtro que siempre.
        payments: paymentLines.map((l) => ({
          method: l.method as PosPaymentMethod,
          amount: Number(l.amount) || 0,
          amount_tendered: l.method === 'efectivo' ? Number(l.tendered) || 0 : undefined,
        })),
        checkout_token: checkoutTokenRef.current,
      })
      setResult(response)
      if (receiptPrinter.autoPrintEnabled) receiptPrinter.print(response.order.id)
    } catch (err) {
      setChargeError(err instanceof Error ? err.message : t('pos.errors.checkout'))
    } finally {
      setCharging(false)
    }
  }

  function resetForNewSale() {
    setCart([])
    setCustomer(null)
    setPaymentLines([createPaymentLine()])
    setResult(null)
    setChargeError(null)
    setQuery('')
    setScanError(null)
    // Venta nueva -- nuevo token, para que no quede pegado al intento de
    // cobro anterior (ya cerrado con éxito).
    checkoutTokenRef.current = crypto.randomUUID()
  }

  if (!tenantId) return <PageSpinner />

  // Totales del pedido ya creado: el header (subtotal/tax_total/total) sale
  // de la respuesta de pos-checkout, y el detalle por tarifa del preview que
  // se mostró justo antes de cobrar (las líneas son exactamente las mismas).
  const resultTotals: OrderTotalsBreakdown | null = result
    ? {
        tax_enabled: result.order.tax_total > 0,
        subtotal: result.order.subtotal,
        discount_total: 0,
        taxable_base: result.order.subtotal - result.order.tax_total,
        tax_total: result.order.tax_total,
        shipping: 0,
        total: result.order.total,
        tax_lines: totals?.tax_lines ?? [],
      }
    : null

  if (result) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-10 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <CheckIcon width={26} height={26} />
        </div>
        <h1 className="text-xs font-bold text-brand-800">{t('pos.success.title')}</h1>
        <p className="text-xs text-brand-500">{t('pos.success.order', { number: String(result.order.number) })}</p>
        <p className="text-xs font-bold text-brand-800">{formatCurrency(result.order.total, result.order.currency)}</p>
        {/* Desglose real de la venta ya registrada: los mismos números que
            el servidor guardó en el pedido (persistOrderItems), con cada
            impuesto discriminado por tarifa. `resultTotals` reusa el
            desglose que ya se tenía en pantalla antes de cobrar -- el
            pedido se acaba de crear con esas mismas líneas, así que no hace
            falta otro viaje de red para pintarlo. */}
        {resultTotals && (
          <OrderTotalsSummary totals={resultTotals} currency={result.order.currency} className="mx-auto max-w-[260px] text-left" />
        )}
        {totalChange > 0 && <p className="text-xs text-brand-600">{t('pos.success.change', { amount: formatCurrency(totalChange, result.order.currency) })}</p>}
        {result.invoice?.status === 'pending' && <p className="text-xs text-amber-600">{t('pos.success.invoicePending')}</p>}
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="outline" onClick={() => navigate(`/app/sales/${result.order.id}`)}>
            {t('pos.actions.viewOrder')}
          </Button>
          <Button onClick={resetForNewSale}>{t('pos.actions.newSale')}</Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="mx-auto"
          onClick={() => receiptPrinter.print(result.order.id)}
          disabled={receiptPrinter.printing}
          aria-label={t('pos.receipt.reprint')}
          title={t('pos.receipt.reprint')}
        >
          <PrinterIcon width={13} height={13} />
        </Button>
        {receiptPrinter.error && <p className="text-xs text-red-600">{receiptPrinter.error}</p>}
        {receiptPrinter.portal}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {/* Escaneo / búsqueda */}
        <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
          <ProductSearchBox
            inputRef={scanInputRef}
            value={query}
            onChange={(v) => {
              setQuery(v)
              setScanError(null)
            }}
            onEnter={handleScanSubmit}
            results={query.trim().length >= 2 ? results : []}
            getKey={(p) => p.id}
            onSelect={handlePick}
            placeholder={t('pos.scan.placeholder')}
            autoFocus
            inputClassName="h-11"
            hint={<p className="mt-1.5 text-[11px] text-brand-400">{t('pos.scan.hint')}</p>}
            error={scanError}
            loading={searching && query.trim().length >= 2}
            loadingLabel={
              <span className="flex items-center gap-2">
                <SearchIcon className="size-3.5 animate-pulse" /> {t('pos.search.searching')}
              </span>
            }
            emptyLabel={query.trim().length >= 2 ? t('pos.search.empty', { term: query }) : null}
            renderResult={(p, highlighted, select) => (
              <ProductSearchResultRow
                imageUrl={p.image_url}
                name={p.name}
                sku={p.sku}
                highlighted={highlighted}
                onClick={select}
                right={
                  <>
                    <span className="block text-xs font-semibold text-brand-800">{formatCurrency(p.price)}</span>
                    {p.track_inventory && !p.has_variants && (
                      <span className={`block text-[10px] ${(p.available ?? 0) <= 0 ? 'text-red-500' : 'text-brand-400'}`}>
                        {(p.available ?? 0) <= 0 ? t('pos.stock.out') : t('pos.stock.available', { count: p.available ?? 0 })}
                      </span>
                    )}
                  </>
                }
              />
            )}
          />
        </div>

        {/* Carrito */}
        <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-brand-800">{t('pos.cart.title')}</h2>
            {cart.length > 0 && (
              <button type="button" onClick={() => setCart([])} className="text-xs font-medium text-brand-400 hover:text-red-600">
                {t('pos.cart.clear')}
              </button>
            )}
          </div>
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-brand-200 py-10 text-center">
              <PackageIcon className="size-7 text-brand-300" />
              <p className="text-xs text-brand-400">{t('pos.cart.empty')}</p>
            </div>
          ) : (
            <div>
              {cart.map((l) => {
                const key = lineKey(l)
                // Único chequeo de stock real: lo que devolvió calculate-order
                // en el mismo preview de totales -- nunca `l.available`
                // (número cacheado de cuando se buscó/escaneó el producto).
                const shortfall = stockShortfalls.find((s) => s.productId === l.product_id && s.variantId === (l.variant_id ?? null))
                return (
                  <div key={key} className={`flex items-center gap-2.5 border-b py-2 last:border-b-0 ${shortfall ? 'border-red-100 bg-red-50/60' : 'border-brand-100'}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-brand-800">{l.name}</p>
                      <p className="truncate text-xs text-brand-400">{[l.variantLabel, l.sku ? `SKU: ${l.sku}` : null].filter(Boolean).join(' · ') || '—'}</p>
                      {shortfall && <p className="text-[11px] font-medium text-red-500">{t('pos.stock.available', { count: shortfall.available })}</p>}
                    </div>
                    <QuantityStepper
                      value={l.quantity}
                      onChange={(v) => updateQuantity(key, v)}
                      invalid={!!shortfall}
                      decreaseLabel={t('common.actions.decreaseQuantity')}
                      increaseLabel={t('common.actions.increaseQuantity')}
                      className="w-24 shrink-0"
                    />
                    <p className="w-24 shrink-0 text-right text-xs font-semibold text-brand-800">{formatCurrency(l.price * l.quantity)}</p>
                    <Button type="button" variant="destructive" size="icon-xs" onClick={() => removeLine(key)} aria-label={t('pos.cart.remove')} className="shrink-0 rounded-full">
                      <TrashIcon width={12} height={12} />
                    </Button>
                  </div>
                )
              })}
              <p className="mt-2 text-right text-xs text-brand-400">{t('pos.cart.items', { count: cart.reduce((s, l) => s + l.quantity, 0) })}</p>
            </div>
          )}
        </div>

        {/* Selector de variante */}
        {variantPickerFor && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setVariantPickerFor(null)}>
            <div className="w-full max-w-sm rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-brand-800">{variantPickerFor.name}</h3>
                <button type="button" onClick={() => setVariantPickerFor(null)} aria-label={t('common.actions.close')}>
                  <XIcon className="size-4 text-brand-400" />
                </button>
              </div>
              <p className="mb-2 text-xs text-brand-400">
                {t('pos.search.chooseVariant')}
                {variantPickerQty > 1 && ` (×${variantPickerQty})`}
              </p>
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {variantPickerFor.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      addToCart(variantPickerFor, v, variantPickerQty)
                      setVariantPickerFor(null)
                    }}
                    className="flex w-full items-center justify-between rounded-lg border border-brand-100 px-3 py-2 text-left text-xs hover:bg-accent-50"
                  >
                    <span>{v.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold text-brand-800">{formatCurrency(v.price)}</span>
                      {v.available != null && (
                        <Badge variant="outline" className={`border-transparent text-[10px] ${v.available <= 0 ? 'bg-red-100 text-red-700' : 'bg-brand-100 text-brand-600'}`}>
                          {v.available <= 0 ? t('pos.stock.out') : t('pos.stock.available', { count: v.available ?? 0 })}
                        </Badge>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <ClientPickerCard
          tenantId={tenantId}
          client={customer}
          onSelect={setCustomer}
          onSearch={(q) => searchPosClients(tenantId, q)}
          emptyLabel={walkIn?.full_name ?? t('pos.customer.walkIn')}
          allowClear
          clearActionLabel={t('pos.customer.useWalkIn')}
          extra={
            customer && (
              <div className="mt-1.5 space-y-0.5 text-xs text-brand-400">
                {customer.credit_enabled && (
                  <p className="flex items-center justify-between gap-2">
                    <span>{t('credit.table.balance')}</span>
                    <span className="font-medium text-brand-600">{formatCurrency(creditBalance)}</span>
                  </p>
                )}
                {storeCreditBalance > 0 && (
                  <p className="flex items-center justify-between gap-2">
                    <span>{t('orders.paymentMethod.storeCredit')}</span>
                    <span className="font-medium text-emerald-600">{formatCurrency(storeCreditBalance)}</span>
                  </p>
                )}
              </div>
            )
          }
        />

        {/* Totales + pago */}
        <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-brand-500 uppercase">{t('pos.totals.title')}</h3>
            {/* Imprimir lo que ya está cargado, sin necesidad de cobrar
                primero -- pedido explícito del usuario. Nunca es la misma
                impresión que la del recibo final: acá no hay pedido ni pago
                todavía, así que sale como PosPendingReceiptTicket (nunca
                "factura de venta"). */}
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={() =>
                receiptPrinter.printPending(
                  cart.map((l) => ({ product_name: l.name, sku: l.sku, quantity: l.quantity, subtotal: l.price * l.quantity })),
                  totals ?? {
                    tax_enabled: false,
                    subtotal: total,
                    discount_total: 0,
                    taxable_base: total,
                    tax_total: 0,
                    shipping: 0,
                    total,
                    tax_lines: [],
                  },
                  { customerName: customer?.full_name ?? walkIn?.full_name ?? null },
                )
              }
              disabled={cart.length === 0 || receiptPrinter.printing}
              aria-label={t('pos.receipt.printPending')}
              title={t('pos.receipt.printPending')}
            >
              <PrinterIcon width={13} height={13} />
            </Button>
          </div>
          {cart.length === 0 ? (
            <p className="mb-3 rounded-xl border border-dashed border-brand-200 px-3 py-4 text-center text-xs text-brand-400">{t('pos.totals.empty')}</p>
          ) : (
            <OrderTotalsSummary totals={totals} loading={totalsLoading} className="mb-2" />
          )}
          {totalsError ? (
            <p className="mb-3 text-[11px] text-red-600">{totalsError}</p>
          ) : (
            cart.length > 0 && <p className="mb-3 text-[11px] text-brand-400">{t('pos.totals.taxHint')}</p>
          )}

          <h3 className="mb-1.5 text-xs font-semibold text-brand-500 uppercase">{t('pos.payment.method')}</h3>
          {/* Mismo catálogo y mismo filtro que PaymentDrawer.tsx (órdenes)
              -- 'credito' solo si el cliente elegido tiene crédito
              habilitado, 'saldo_favor' solo si tiene saldo a favor real,
              'wompi' nunca se ofrece acá (solo lo escribe el webhook
              cuando se paga un link). Componente compartido con
              PaymentDrawer.tsx -- ver components/molecules/PaymentLinesEditor.tsx. */}
          <div className="mb-3">
            <PaymentLinesEditor
              lines={paymentLines}
              onChange={setPaymentLines}
              availableMethods={(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[]).filter(
                (m) => m !== 'wompi' && (m !== 'credito' || customer?.credit_enabled) && (m !== 'saldo_favor' || storeCreditBalance > 0),
              )}
              totalTarget={total}
              storeCreditBalance={storeCreditBalance}
            />
          </div>

          {isSplitPayment && (
            <div className={`mb-3 flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium ${Math.abs(remainingToAssign) < 0.01 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
              <span>{t('pos.payment.assigned')}</span>
              <span>
                {formatCurrency(assignedTotal)} / {formatCurrency(total)}
              </span>
            </div>
          )}

          {storeCreditExceeded && (
            <p className="mb-3 text-xs font-medium text-red-600">
              {t('orders.paymentDrawer.errors.amountExceedsBalance', { amount: formatCurrency(storeCreditBalance) })}
            </p>
          )}

          {stockShortfalls.length > 0 && (
            <p className="mb-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{t('pos.tabs.errors.stockShortfall')}</p>
          )}

          {chargeError && <p className="mb-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{chargeError}</p>}

          <Button type="button" size="lg" className="w-full" disabled={!canCharge} onClick={handleCharge}>
            {charging ? t('pos.actions.charging') : t('pos.actions.charge', { amount: formatCurrency(total) })}
          </Button>
        </div>
      </div>

      {receiptPrinter.portal}
      {receiptPrinter.error && <p className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow-lg">{receiptPrinter.error}</p>}
    </div>
  )
}
