import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { usePermission } from '../../../contexts/AuthContext'
import { saveCartDraft, listChargesFromCart, createOrderFromCart, closeCart, deleteCart, getCart } from '../../../lib/api/carts'
import type { CartCharge } from '../../../lib/api/carts'
import { getClient } from '../../../lib/api/clients'
import { getClientCreditSummary } from '../../../lib/api/credit'
import { getStoreCreditBalance } from '../../../lib/api/returns'
import { previewOrderTotals } from '../../../lib/api/orders'
import type { OrderItemInput, OrderTotalsBreakdown } from '../../../lib/api/orders'
import { useOrderTotalsPreview } from '../../../lib/useOrderTotalsPreview'
import { listProducts } from '../../../lib/api/products'
import type { ProductWithImages } from '../../../lib/api/products'
import { listProductCategories } from '../../../lib/api/productCategories'
import { listBrands } from '../../../lib/api/brands'
import { listWarehouses } from '../../../lib/api/warehouses'
import { listStockByWarehouse } from '../../../lib/api/stockMovements'
import type { ProductWarehouseStockRow } from '../../../lib/api/stockMovements'
import type { Brand, CartItem, Client, PosPoint, ProductCategory, Warehouse } from '../../../types/domain'
import { OrderItemsEditor } from '../orders/OrderItemsEditor'
import { PaymentDrawer } from '../orders/PaymentDrawer'
import { PosCustomerCard } from './PosCustomerCard'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { PageSpinner } from '@/components/atoms'
import { OrderTotalsSummary } from '@/components/molecules'
import { PrinterIcon } from '@/components/atoms/icons'
import { usePosReceiptPrinter } from '../../../lib/usePosReceiptPrinter'
import { ChevronLeftIcon } from '@/components/atoms/icons'
import { XIcon } from 'lucide-react'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Pantalla de una cuenta abierta -- arma el borrador con el mismo
 * OrderItemsEditor que usa OrderDetail.tsx, autoguardado hacia el
 * carrito (calculate-order, nunca sales_orders). "Cobrar" es el único
 * momento en que create-order convierte el carrito en un pedido real,
 * seguido del mismo confirmar+pagar de cualquier venta. Sin validación
 * previa en el cliente en ningún paso -- se llama al backend y se
 * muestra el error que devuelva, tal cual. */
export function PosTabAccount({ tenantId, cartId, points, onBack, onClosed }: { tenantId: string; cartId: string; points: PosPoint[]; onBack: () => void; onClosed: () => void }) {
  const { t } = useLanguage()
  const canCheckout = usePermission('pos.checkout')
  const receiptPrinter = usePosReceiptPrinter(tenantId)

  const [loaded, setLoaded] = useState(false)
  const [contactId, setContactId] = useState('')
  const [customer, setCustomer] = useState<Client | null>(null)
  const [posPointId, setPosPointId] = useState('')
  const [label, setLabel] = useState('')
  const [items, setItems] = useState<OrderItemInput[]>([])

  const [products, setProducts] = useState<ProductWithImages[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [stockRows, setStockRows] = useState<ProductWarehouseStockRow[]>([])

  const [creditBalance, setCreditBalance] = useState(0)
  const [storeCreditBalance, setStoreCreditBalance] = useState(0)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [charging, setCharging] = useState(false)
  const [closing, setClosing] = useState(false)
  // Lo ya cobrado de esta cuenta. Los productos cobrados salen del carrito
  // (ahí solo queda lo pendiente) y viven en su pedido -- esta lista es lo
  // que le permite al cajero ver qué se llevó la mesa y si quedó pago.
  // Además, con al menos un cobro hecho "Cancelar cuenta" deja de
  // ofrecerse: borrar el carrito perdería el vínculo con esos pedidos (FK
  // ON DELETE SET NULL), y lo que corresponde ahí es cerrarla.
  const [charges, setCharges] = useState<CartCharge[]>([])
  const [confirmingClose, setConfirmingClose] = useState(false)
  /** Cobro en curso: qué se va a cobrar y por cuánto. Abrir el drawer con
   * esto NO escribe nada -- el pedido se crea (y se confirma) recién cuando
   * el cajero registra el pago, ver createOrder en PaymentDrawer. Antes se
   * creaba acá, así que cerrar el drawer sin pagar dejaba la venta hecha y
   * la cuenta sin sus productos (bug reportado por el usuario). */
  const [pendingCharge, setPendingCharge] = useState<{ items?: { id: string; quantity: number }[]; totals: OrderTotalsBreakdown } | null>(null)

  // Dividir cuenta por producto -- opcional, aparte del botón "Cobrar"
  // principal (que sigue cobrando todo de un tirón, sin este paso extra,
  // para no volver más lento el caso común). splitItems trae los
  // cart_items reales (con id) recién releídos del carrito -- la lista
  // local `items` no sirve para esto porque una línea recién agregada
  // todavía puede no tener id propio hasta que se guarda.
  const [splitItems, setSplitItems] = useState<CartItem[] | null>(null)
  // Cuánto de cada línea se va a cobrar en esta pasada -- por default,
  // toda la cantidad de cada una (mismo criterio que "cobrar todo"), el
  // cajero baja el número de lo que no va en este cobro.
  const [selectedQuantities, setSelectedQuantities] = useState<Map<string, number>>(new Map())
  const [openingSplit, setOpeningSplit] = useState(false)

  useEffect(() => {
    listProducts(tenantId, { page: 1, pageSize: 1000 })
      .then(({ data }) => setProducts(data))
      .catch(() => {})
    listProductCategories(tenantId).then(setCategories).catch(() => {})
    listBrands(tenantId).then(setBrands).catch(() => {})
    listWarehouses(tenantId).then(setWarehouses).catch(() => {})
    listStockByWarehouse(tenantId).then(setStockRows).catch(() => {})
  }, [tenantId])

  useEffect(() => {
    getCart(cartId).then((cart) => {
      if (!cart) return
      setContactId(cart.contact_id ?? '')
      setPosPointId(cart.pos_point_id ?? '')
      setLabel(cart.label ?? '')
      setItems(
        cart.items.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          warehouse_id: i.warehouse_id,
          product_name: i.product_name,
          sku: i.sku,
          quantity: i.quantity,
          unit_price: i.unit_price,
          discount_amount: i.discount_amount,
        })),
      )
      setLoaded(true)
    })
    listChargesFromCart(cartId).then(setCharges).catch(() => {})
  }, [cartId])

  useEffect(() => {
    if (!contactId) {
      setCustomer(null)
      return
    }
    getClient(contactId).then(setCustomer).catch(() => setCustomer(null))
  }, [contactId])

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

  // Autoguardado debounced hacia el carrito -- mismo mecanismo que
  // OrderDetail.tsx, apuntando a saveCartDraft en vez de calculateOrder
  // con order_id.
  const primedRef = useRef(false)
  const drawerDoneRef = useRef(false)
  const lastSyncedRef = useRef('')

  function snapshot(): string {
    return JSON.stringify({ contactId, posPointId, label, items })
  }

  async function flush(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await saveCartDraft({ cart_id: cartId, contact_id: contactId, items, pos_point_id: posPointId || null, label: label || null })
      lastSyncedRef.current = snapshot()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.save'))
      throw err
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!loaded) return
    const snap = snapshot()
    if (!primedRef.current) {
      primedRef.current = true
      lastSyncedRef.current = snap
      return
    }
    if (snap === lastSyncedRef.current) return
    const timer = setTimeout(() => {
      void flush()
    }, 2000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, contactId, posPointId, label, items])

  // Desglose de la cuenta antes de cobrarla -- hasta ahora esta pantalla no
  // mostraba ningún total (el cajero solo veía las líneas), así que no había
  // forma de saber cuánto iba la mesa ni cuánto de eso era impuesto. Lo
  // calcula el servidor con las mismas reglas del pedido real, ver
  // useOrderTotalsPreview.
  const { totals, loading: totalsLoading, error: totalsError } = useOrderTotalsPreview(items)

  /** Cerrar la mesa: acción propia, nunca un efecto de haber cobrado. Se
   * ofrece recién cuando la cuenta ya no tiene productos por cobrar --
   * mientras queden, o se cobran, o se descarta la cuenta entera con
   * "Cancelar cuenta". */
  async function handleClose() {
    setClosing(true)
    try {
      await closeCart(cartId)
      onClosed()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.close'))
      setClosing(false)
      setConfirmingClose(false)
    }
  }

  const posPointName = points.find((p) => p.id === posPointId)?.name ?? null

  async function handleCancel() {
    setCancelling(true)
    try {
      await deleteCart(cartId)
      onClosed()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.cancel'))
      setCancelling(false)
      setConfirmingCancel(false)
    }
  }

  async function handleCharge(selectedItems?: { id: string; quantity: number }[]) {
    setCharging(true)
    setError(null)
    try {
      // Nada se escribe todavía: solo se resuelve, del lado del servidor, el
      // desglose de lo que se va a cobrar (el pedido y su confirmación
      // salen al guardar el pago). Para el cobro completo ya lo tenemos
      // cargado del preview de la cuenta; para un cobro dividido hay que
      // pedir el de esas cantidades puntuales.
      const chargeTotals = selectedItems
        ? await previewOrderTotals(
            (splitItems ?? [])
              .filter((item) => selectedItems.some((sel) => sel.id === item.id))
              .map((item) => {
                const selected = selectedItems.find((sel) => sel.id === item.id)!
                return {
                  product_id: item.product_id,
                  variant_id: item.variant_id,
                  warehouse_id: item.warehouse_id,
                  product_name: item.product_name,
                  sku: item.sku,
                  quantity: selected.quantity,
                  unit_price: item.unit_price,
                  // Mismo criterio que create-order: el descuento de la
                  // línea solo cuenta si se cobra completa.
                  discount_amount: selected.quantity === item.quantity ? (item.discount_amount ?? 0) : 0,
                }
              }),
          )
        : (totals ?? (await previewOrderTotals(items)))
      setSplitItems(null)
      drawerDoneRef.current = false
      setPendingCharge({ items: selectedItems, totals: chargeTotals })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.charge'))
    } finally {
      setCharging(false)
    }
  }

  async function handleChargeAll() {
    // Solo re-guarda si quedó algo sin sincronizar desde el último
    // autosave -- el caso común (cajero agrega productos, espera un
    // toque, recién ahí cobra) ya está guardado, forzar un viaje de red
    // extra ahí no suma nada más que lentitud.
    if (snapshot() !== lastSyncedRef.current) {
      setCharging(true)
      try {
        await flush()
      } catch {
        setCharging(false)
        return
      }
    }
    await handleCharge()
  }

  /** Abre el selector de "dividir cuenta" -- primero flushea si hace
   * falta y recién ahí relee el carrito del servidor, porque una línea
   * agregada hace instantes puede no tener id propio todavía en el
   * estado local. */
  async function handleOpenSplit() {
    setOpeningSplit(true)
    setError(null)
    try {
      if (snapshot() !== lastSyncedRef.current) await flush()
      const cart = await getCart(cartId)
      if (!cart) throw new Error(t('pos.tabs.errors.save'))
      setSplitItems(cart.items)
      setSelectedQuantities(new Map(cart.items.map((i) => [i.id, i.quantity])))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.save'))
    } finally {
      setOpeningSplit(false)
    }
  }

  /** Acota siempre entre 0 y la cantidad real de la línea -- no hay forma
   * de cobrar más unidades de las que tiene el carrito. */
  function setSplitQuantity(item: CartItem, quantity: number) {
    const clamped = Math.max(0, Math.min(item.quantity, Math.round(quantity)))
    setSelectedQuantities((prev) => new Map(prev).set(item.id, clamped))
  }

  // El descuento de la línea solo cuenta acá cuando se seleccionó su
  // cantidad completa -- mismo criterio que aplica create-order del lado
  // del servidor (ver su comentario de cabecera), para que este total no
  // le prometa al cajero algo distinto de lo que después cobra de verdad.
  const splitSelectedTotal = (splitItems ?? []).reduce((sum, i) => {
    const qty = selectedQuantities.get(i.id) ?? 0
    const discount = qty === i.quantity ? (i.discount_amount ?? 0) : 0
    return sum + qty * i.unit_price - discount
  }, 0)

  /** Tras pagar (total o parcial), la cuenta puede seguir teniendo
   * productos sin cobrar -- create-order la deja abierta en ese caso. Si
   * todavía queda algo, se recarga acá mismo mostrando lo que resta; si
   * no, se vuelve al listado (la mesa quedó libre). */
  /** Se llama al salir del drawer de pago, se haya registrado el pago o no
   * -- nunca se vuelve al listado: cobrar no cierra la mesa (pedido
   * explícito del usuario). Releer es obligatorio en los DOS casos: los
   * ítems que se acaban de cobrar ya salieron del carrito del lado del
   * servidor, así que si el estado local se quedara con ellos el
   * autoguardado los volvería a insertar en la cuenta y se cobrarían dos
   * veces. Si no quedó nada, la cuenta sigue abierta e igual de usable (se
   * le pueden seguir cargando productos) hasta que el cajero apriete
   * "Cerrar cuenta". */
  async function handlePaymentDrawerDone() {
    // PaymentDrawer llama onSaved() y acto seguido onClose() al guardar --
    // ambos apuntan acá, así que sin esta guarda se releería el carrito dos
    // veces por el mismo cobro.
    if (drawerDoneRef.current) return
    drawerDoneRef.current = true
    setPendingCharge(null)
    listChargesFromCart(cartId).then(setCharges).catch(() => {})
    const cart = await getCart(cartId).catch(() => null)
    if (!cart) return
    // Vuelve a "primer render" para el autosave -- este es el nuevo estado
    // base recién leído del servidor, no una edición pendiente que haya que
    // volver a guardar (snapshot() todavía vería el `items` de antes de
    // este setItems, React no lo actualiza en el momento).
    primedRef.current = false
    setItems(
      cart.items.map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id,
        warehouse_id: i.warehouse_id,
        product_name: i.product_name,
        sku: i.sku,
        quantity: i.quantity,
        unit_price: i.unit_price,
        discount_amount: i.discount_amount,
      })),
    )
  }

  if (!loaded) return <PageSpinner />

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm font-medium text-brand-500 hover:text-brand-700">
        <ChevronLeftIcon width={14} height={14} /> {t('pos.tabs.backToList')}
      </button>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <OrderItemsEditor items={items} products={products} categories={categories} brands={brands} warehouses={warehouses} stockRows={stockRows} onChange={setItems} />

          {/* Lo ya cobrado de esta mesa. Sin esto, después de cobrar la
              cuenta quedaba abierta y vacía y no había forma de saber qué
              se había llevado: los productos cobrados salen del carrito (que
              solo lleva lo pendiente) y pasan a vivir en su pedido, así que
              este es el único lugar donde el cajero los vuelve a ver, con su
              estado de pago. */}
          {charges.length > 0 && (
            <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-brand-800">{t('pos.tabs.charges.title')}</h3>
                <span className="text-sm font-bold text-brand-800">{formatCurrency(charges.reduce((sum, c) => sum + c.total, 0), charges[0]?.currency)}</span>
              </div>
              <div className="divide-y divide-brand-100">
                {charges.map((charge) => {
                  const pending = charge.total - charge.paid
                  return (
                    <div key={charge.id} className="py-2 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <a
                          href={`/app/sales/${charge.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-xs font-medium text-accent-600 hover:underline"
                        >
                          {t('pos.tabs.charges.order', { number: String(charge.number) })}
                        </a>
                        <span className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => receiptPrinter.print(charge.id, posPointName)}
                            disabled={receiptPrinter.printing}
                            aria-label={t('pos.receipt.reprint')}
                            title={t('pos.receipt.reprint')}
                            className="text-brand-300 hover:text-accent-600 disabled:cursor-not-allowed"
                          >
                            <PrinterIcon width={13} height={13} />
                          </button>
                          <Badge
                            variant="outline"
                            className={`border-transparent text-[10px] ${pending > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}
                          >
                            {pending > 0 ? t('pos.tabs.charges.pending', { amount: formatCurrency(pending, charge.currency) }) : t('pos.tabs.charges.paid')}
                          </Badge>
                          <span className="text-sm font-semibold text-brand-800">{formatCurrency(charge.total, charge.currency)}</span>
                        </span>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {charge.items.map((item, index) => (
                          <li key={index} className="flex items-baseline justify-between gap-3 text-xs text-brand-500">
                            <span className="truncate">
                              {item.quantity} × {item.product_name}
                            </span>
                            <span className="shrink-0 tabular-nums">{formatCurrency(item.subtotal, charge.currency)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <PosCustomerCard tenantId={tenantId} walkInName={customer?.full_name} customer={customer} onSelect={(c) => setContactId(c?.id ?? '')} creditBalance={creditBalance} storeCreditBalance={storeCreditBalance} />

          {points.length > 0 && (
            <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
              <Label>{t('pos.tabs.point')}</Label>
              <Select value={posPointId || 'none'} onValueChange={(v) => setPosPointId(v === 'none' ? '' : v)}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('pos.tabs.noPointOption')}</SelectItem>
                  {points.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label className="mt-3 block">{t('pos.tabs.labelField')}</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('pos.tabs.labelPlaceholder')} className="mt-1" />
            </div>
          )}

          <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-brand-500 uppercase">{t('pos.totals.title')}</h3>
            {items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-brand-200 px-3 py-4 text-center text-xs text-brand-400">{t('pos.totals.empty')}</p>
            ) : (
              <>
                <OrderTotalsSummary totals={totals} loading={totalsLoading} />
                {totalsError ? (
                  <p className="mt-1.5 text-[11px] text-red-600">{totalsError}</p>
                ) : (
                  <p className="mt-1.5 text-[11px] text-brand-400">{t('pos.totals.taxHint')}</p>
                )}
              </>
            )}
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onBack} disabled={saving}>
              {t('pos.tabs.saveAndBack')}
            </Button>
            {charges.length === 0 && (
              <Button type="button" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingCancel(true)}>
                {t('pos.tabs.cancelAccount')}
              </Button>
            )}
          </div>
          {/* Cobrar y cerrar la mesa son dos acciones distintas (pedido
              explícito del usuario): mientras haya productos por cobrar, el
              botón principal cobra y deja la cuenta abierta; recién cuando
              ya no queda nada por cobrar se ofrece cerrarla. Nunca se cierra
              sola al registrar un pago. */}
          {items.length === 0 ? (
            <>
              {charges.length > 0 && <p className="text-center text-xs text-brand-400">{t('pos.tabs.nothingToCharge')}</p>}
              <Button type="button" size="lg" className="w-full" disabled={closing} onClick={() => setConfirmingClose(true)}>
                {closing ? t('pos.tabs.closing') : t('pos.tabs.closeAccount')}
              </Button>
            </>
          ) : (
            <Button type="button" size="lg" className="w-full" disabled={!canCheckout || charging} onClick={handleChargeAll}>
              {charging ? t('pos.actions.charging') : t('pos.tabs.charge')}
            </Button>
          )}
          {(items.length > 1 || items.some((i) => i.quantity > 1)) && (
            <button
              type="button"
              onClick={handleOpenSplit}
              disabled={!canCheckout || openingSplit || charging}
              className="block w-full text-center text-xs font-medium text-accent-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {openingSplit ? t('common.actions.saving') : t('pos.tabs.splitBill')}
            </button>
          )}
        </div>
      </div>

      {receiptPrinter.portal}
      {receiptPrinter.error && <p className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow-lg">{receiptPrinter.error}</p>}

      <ConfirmDialog
        open={confirmingClose}
        onClose={() => setConfirmingClose(false)}
        onConfirm={handleClose}
        title={t('pos.tabs.closeConfirm.title')}
        description={t('pos.tabs.closeConfirm.description')}
        loading={closing}
      />

      <ConfirmDialog
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        onConfirm={handleCancel}
        title={t('pos.tabs.cancelConfirm.title')}
        description={t('pos.tabs.cancelConfirm.description')}
        loading={cancelling}
      />

      {pendingCharge && (
        <PaymentDrawer
          open
          onClose={handlePaymentDrawerDone}
          tenantId={tenantId}
          order={null}
          totals={pendingCharge.totals}
          pendingAmount={pendingCharge.totals.total}
          createOrder={() => createOrderFromCart(cartId, pendingCharge.items, { keepCartOpen: true, confirm: true })}
          creditEnabled={customer?.credit_enabled ?? false}
          storeCreditBalance={storeCreditBalance}
          onSaved={(chargedOrder) => {
            if (receiptPrinter.autoPrintEnabled) receiptPrinter.print(chargedOrder.id, posPointName)
            handlePaymentDrawerDone()
          }}
        />
      )}

      {/* Dividir cuenta -- selección de qué productos van en este cobro,
          el resto se queda en la misma cuenta abierta. Ver handleOpenSplit. */}
      {splitItems && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSplitItems(null)}>
          <div className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-brand-800">{t('pos.tabs.splitBillTitle')}</h3>
              <button type="button" onClick={() => setSplitItems(null)} aria-label={t('common.actions.close')}>
                <XIcon className="size-4 text-brand-400" />
              </button>
            </div>
            <div className="space-y-1.5">
              {splitItems.map((item) => {
                const qty = selectedQuantities.get(item.id) ?? 0
                const lineTotal = qty * item.unit_price - (qty === item.quantity ? (item.discount_amount ?? 0) : 0)
                return (
                  <div key={item.id} className="flex items-center gap-2.5 rounded-lg border border-brand-100 px-2.5 py-2">
                    {item.quantity === 1 ? (
                      <Checkbox checked={qty > 0} onCheckedChange={(checked) => setSplitQuantity(item, checked ? 1 : 0)} />
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" variant="outline" size="icon-xs" onClick={() => setSplitQuantity(item, qty - 1)} disabled={qty <= 0}>
                          −
                        </Button>
                        <Input
                          type="number"
                          min={0}
                          max={item.quantity}
                          value={qty}
                          onChange={(e) => setSplitQuantity(item, Number(e.target.value) || 0)}
                          className="h-7 w-12 text-center"
                        />
                        <Button type="button" variant="outline" size="icon-xs" onClick={() => setSplitQuantity(item, qty + 1)} disabled={qty >= item.quantity}>
                          +
                        </Button>
                      </div>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-brand-800">{item.product_name}</span>
                      <span className="block text-xs text-brand-400">
                        {item.quantity > 1 ? `${qty}/${item.quantity} · ` : ''}
                        {formatCurrency(item.unit_price)} c/u
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-brand-800">{formatCurrency(lineTotal)}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-brand-100 pt-3 text-sm">
              <span className="text-brand-500">{t('pos.tabs.splitSelectedTotal')}</span>
              <span className="font-bold text-brand-800">{formatCurrency(splitSelectedTotal)}</span>
            </div>
            {error && <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}
            <Button
              type="button"
              size="lg"
              className="mt-3 w-full"
              disabled={charging || splitSelectedTotal <= 0}
              onClick={() =>
                handleCharge(
                  Array.from(selectedQuantities.entries())
                    .filter(([, quantity]) => quantity > 0)
                    .map(([id, quantity]) => ({ id, quantity })),
                )
              }
            >
              {charging ? t('pos.actions.charging') : t('pos.tabs.chargeSelected', { amount: formatCurrency(splitSelectedTotal) })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
