import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckIcon, PackageIcon, SearchIcon, XIcon } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'
import { useLanguage } from '../../../contexts/LanguageContext'
import { getWalkInClient, lookupPosBarcode, posCheckout, searchPosProducts, type PosCheckoutResult, type PosPaymentMethod, type PosProduct, type PosVariantOption } from '../../../lib/api/pos'
import { PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import type { OrderItemInput, OrderTotalsBreakdown } from '../../../lib/api/orders'
import { useOrderTotalsPreview } from '../../../lib/useOrderTotalsPreview'
import { usePosReceiptPrinter } from '../../../lib/usePosReceiptPrinter'
import { getClientCreditSummary } from '../../../lib/api/credit'
import { getStoreCreditBalance } from '../../../lib/api/returns'
import type { Client, OrderPaymentMethod } from '../../../types/domain'
import { PageSpinner, ProductImage } from '@/components/atoms'
import { CurrencyInput, OrderTotalsSummary } from '@/components/molecules'
import { PrinterIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScanIcon, TrashIcon } from '@/components/atoms/icons'
import { PosCustomerCard } from './PosCustomerCard'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
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

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<PosProduct[]>([])
  const [scanError, setScanError] = useState<string | null>(null)
  const [variantPickerFor, setVariantPickerFor] = useState<PosProduct | null>(null)
  const scanInputRef = useRef<HTMLInputElement>(null)

  const [customer, setCustomer] = useState<Client | null>(null)
  // Igual que OrderDetail.tsx: 'credito' solo se ofrece si el cliente tiene
  // credit_enabled, 'saldo_favor' solo si tiene saldo a favor real -- se
  // resuelve apenas se elige un cliente real (el consumidor final nunca
  // tiene ninguno de los dos).
  const [creditBalance, setCreditBalance] = useState(0)
  const [storeCreditBalance, setStoreCreditBalance] = useState(0)

  const [method, setMethod] = useState<PosPaymentMethod>('efectivo')
  const [tendered, setTendered] = useState('')
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

  // Si el método elegido deja de estar disponible (se cambió a un cliente
  // sin crédito, o al consumidor final) vuelve a efectivo -- nunca se
  // manda un método que ya no aparece en el select.
  useEffect(() => {
    if (method === 'credito' && !customer?.credit_enabled) setMethod('efectivo')
    if (method === 'saldo_favor' && storeCreditBalance <= 0) setMethod('efectivo')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, storeCreditBalance])

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

  function handlePick(product: PosProduct) {
    if (product.has_variants) {
      setVariantPickerFor(product)
    } else {
      addToCart(product, null)
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
  const { totals, loading: totalsLoading, error: totalsError } = useOrderTotalsPreview(previewItems)

  // Mientras el desglose viaja (o si falla), el botón de cobrar y el vuelto
  // siguen funcionando con la suma de las líneas: el total no depende del
  // impuesto (está incluido en el precio), solo su reparto entre base e
  // impuesto -- que es justo lo que se espera del servidor.
  const total = totals?.total ?? cart.reduce((sum, l) => sum + l.price * l.quantity, 0)
  const tenderedNumber = Number(tendered) || 0
  const change = method === 'efectivo' ? Math.max(0, tenderedNumber - total) : 0
  const insufficientCash = method === 'efectivo' && tendered.trim() !== '' && tenderedNumber < total
  // 'saldo_favor' nunca puede cubrir más de lo que el cliente tiene a favor
  // -- mismo tope que PaymentDrawer.tsx (ahí es un máximo por pago parcial,
  // acá el pago siempre es por el total porque el POS no admite pagos
  // divididos en esta primera ronda).
  const storeCreditExceeded = method === 'saldo_favor' && total > storeCreditBalance
  const canCharge = cart.length > 0 && !charging && !storeCreditExceeded && !(method === 'efectivo' && (tendered.trim() === '' || tenderedNumber < total))

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
        payment: {
          method,
          amount: total,
          amount_tendered: method === 'efectivo' ? tenderedNumber : undefined,
        },
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
    setMethod('efectivo')
    setTendered('')
    setResult(null)
    setChargeError(null)
    setQuery('')
    setScanError(null)
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
        <h1 className="text-xl font-bold text-brand-800">{t('pos.success.title')}</h1>
        <p className="text-sm text-brand-500">{t('pos.success.order', { number: String(result.order.number) })}</p>
        <p className="text-2xl font-bold text-brand-800">{formatCurrency(result.order.total, result.order.currency)}</p>
        {/* Desglose real de la venta ya registrada: los mismos números que
            el servidor guardó en el pedido (persistOrderItems), con cada
            impuesto discriminado por tarifa. `resultTotals` reusa el
            desglose que ya se tenía en pantalla antes de cobrar -- el
            pedido se acaba de crear con esas mismas líneas, así que no hace
            falta otro viaje de red para pintarlo. */}
        {resultTotals && (
          <OrderTotalsSummary totals={resultTotals} currency={result.order.currency} className="mx-auto max-w-[260px] text-left" />
        )}
        {change > 0 && <p className="text-sm text-brand-600">{t('pos.success.change', { amount: formatCurrency(change, result.order.currency) })}</p>}
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
        <div className="relative rounded-2xl border border-brand-100 bg-white p-3.5">
          <div className="relative">
            <ScanIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-brand-300" />
            <Input
              ref={scanInputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setScanError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleScanSubmit()
                }
              }}
              placeholder={t('pos.scan.placeholder')}
              autoFocus
              className="h-11 pl-9 text-sm"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-brand-400">{t('pos.scan.hint')}</p>
          {scanError && <p className="mt-1.5 text-xs font-medium text-red-600">{scanError}</p>}

          {query.trim().length >= 2 && (
            <div className="mt-2 max-h-72 divide-y divide-brand-100 overflow-y-auto rounded-lg border border-brand-100">
              {searching && (
                <p className="flex items-center gap-2 px-3 py-3 text-xs text-brand-400">
                  <SearchIcon className="size-3.5 animate-pulse" /> {t('pos.search.searching')}
                </p>
              )}
              {!searching && results.length === 0 && <p className="px-3 py-4 text-center text-xs text-brand-400">{t('pos.search.empty', { term: query })}</p>}
              {!searching &&
                results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handlePick(p)}
                    disabled={p.track_inventory && !p.has_variants && (p.available ?? 0) <= 0}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ProductImage src={p.image_url} name={p.name} className="size-9 shrink-0 rounded-lg" iconSize={16} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-brand-800">{p.name}</span>
                      <span className="block truncate text-xs text-brand-400">{p.sku ? `SKU: ${p.sku}` : '—'}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-semibold text-brand-800">{formatCurrency(p.price)}</span>
                      {p.track_inventory && !p.has_variants && (
                        <span className={`block text-[11px] ${(p.available ?? 0) <= 0 ? 'text-red-500' : 'text-brand-400'}`}>
                          {(p.available ?? 0) <= 0 ? t('pos.stock.out') : t('pos.stock.available', { count: p.available ?? 0 })}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Carrito */}
        <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-brand-800">{t('pos.cart.title')}</h2>
            {cart.length > 0 && (
              <button type="button" onClick={() => setCart([])} className="text-xs font-medium text-brand-400 hover:text-red-600">
                {t('pos.cart.clear')}
              </button>
            )}
          </div>
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-brand-200 py-10 text-center">
              <PackageIcon className="size-7 text-brand-300" />
              <p className="text-sm text-brand-400">{t('pos.cart.empty')}</p>
            </div>
          ) : (
            <div>
              {cart.map((l) => {
                const key = lineKey(l)
                const short = l.available != null && l.available < l.quantity
                return (
                  <div key={key} className="flex items-center gap-2.5 border-b border-brand-100 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-brand-800">{l.name}</p>
                      <p className="truncate text-xs text-brand-400">{[l.variantLabel, l.sku ? `SKU: ${l.sku}` : null].filter(Boolean).join(' · ') || '—'}</p>
                      {short && <p className="text-[11px] font-medium text-red-500">{t('pos.stock.available', { count: l.available ?? 0 })}</p>}
                    </div>
                    <Input
                      type="number"
                      min="1"
                      value={l.quantity}
                      onChange={(e) => updateQuantity(key, Number(e.target.value) || 0)}
                      aria-label={t('pos.cart.quantity')}
                      className={`h-8 w-16 text-right ${short ? 'border-red-400 text-red-700' : ''}`}
                    />
                    <p className="w-24 shrink-0 text-right text-sm font-semibold text-brand-800">{formatCurrency(l.price * l.quantity)}</p>
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
                <h3 className="text-sm font-semibold text-brand-800">{variantPickerFor.name}</h3>
                <button type="button" onClick={() => setVariantPickerFor(null)} aria-label={t('common.actions.close')}>
                  <XIcon className="size-4 text-brand-400" />
                </button>
              </div>
              <p className="mb-2 text-xs text-brand-400">{t('pos.search.chooseVariant')}</p>
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {variantPickerFor.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    disabled={v.available != null && v.available <= 0}
                    onClick={() => {
                      addToCart(variantPickerFor, v)
                      setVariantPickerFor(null)
                    }}
                    className="flex w-full items-center justify-between rounded-lg border border-brand-100 px-3 py-2 text-left text-sm hover:bg-accent-50 disabled:cursor-not-allowed disabled:opacity-40"
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
        <PosCustomerCard
          tenantId={tenantId}
          walkInName={walkIn?.full_name}
          customer={customer}
          onSelect={setCustomer}
          creditBalance={creditBalance}
          storeCreditBalance={storeCreditBalance}
        />

        {/* Totales + pago */}
        <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-brand-500 uppercase">{t('pos.totals.title')}</h3>
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
          {/* Mismo catálogo y mismo filtro que PaymentDrawer.tsx (órdenes) --
              'credito' solo si el cliente elegido tiene crédito habilitado,
              'saldo_favor' solo si tiene saldo a favor real, 'wompi' nunca
              se ofrece acá (solo lo escribe el webhook cuando se paga un
              link, ver PosPaymentMethod). */}
          <Select value={method} onValueChange={(v) => setMethod(v as PosPaymentMethod)}>
            <SelectTrigger className="mb-3 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[])
                .filter((m) => m !== 'wompi' && (m !== 'credito' || customer?.credit_enabled) && (m !== 'saldo_favor' || storeCreditBalance > 0))
                .map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(PAYMENT_METHOD_LABEL_KEY[m])}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          {method === 'efectivo' && (
            <div className="mb-3 space-y-1.5">
              <label className="block text-xs font-medium text-brand-500">{t('pos.payment.tendered')}</label>
              <CurrencyInput value={tendered} onChange={(e) => setTendered(e.target.value)} className="h-9 text-right text-sm" />
              {insufficientCash && <p className="text-xs font-medium text-red-600">{t('pos.payment.insufficient')}</p>}
              {!insufficientCash && change > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-brand-500">{t('pos.payment.change')}</span>
                  <span className="font-semibold text-emerald-600">{formatCurrency(change)}</span>
                </div>
              )}
            </div>
          )}

          {storeCreditExceeded && (
            <p className="mb-3 text-xs font-medium text-red-600">
              {t('orders.paymentDrawer.errors.amountExceedsBalance', { amount: formatCurrency(storeCreditBalance) })}
            </p>
          )}

          {chargeError && <p className="mb-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{chargeError}</p>}

          <Button type="button" size="lg" className="w-full" disabled={!canCharge} onClick={handleCharge}>
            {charging ? t('pos.actions.charging') : t('pos.actions.charge', { amount: formatCurrency(total) })}
          </Button>
        </div>
      </div>
    </div>
  )
}
