import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatDate, formatTime } from '../../../lib/dates'
import { usePermission } from '../../../contexts/AuthContext'
import { useToast } from '../../../contexts/ToastContext'
import { saveCartDraft, enqueueCartSave, waitForCartSaves, CartStockRejectedError, listChargesFromCart, createOrderFromCart, closeCart, deleteCart, getCart } from '../../../lib/api/carts'
import type { CartCharge, CartWithItems, SaveCartDraftInput } from '../../../lib/api/carts'
import { posOpenMark } from '../../../lib/posPerf'
import { getClient } from '../../../lib/api/clients'
import { searchPosClients } from '../../../lib/api/pos'
import { getClientCreditSummary } from '../../../lib/api/credit'
import { getStoreCreditBalance } from '../../../lib/api/returns'
import { isDianDirectoConnected } from '../../../lib/api/integrations'
import { previewOrderTotals, getOrderBare } from '../../../lib/api/orders'
import type { OrderItemInput, OrderTotalsBreakdown, StockShortfall } from '../../../lib/api/orders'
import { useOrderTotalsPreview, orderTotalsSignature, type PrefetchedTotals } from '../../../lib/useOrderTotalsPreview'
import { listProducts } from '../../../lib/api/products'
import type { ProductWithImages } from '../../../lib/api/products'
import { listProductCategories } from '../../../lib/api/productCategories'
import { listBrands } from '../../../lib/api/brands'
import { listWarehouses } from '../../../lib/api/warehouses'
import { listStockByWarehouse } from '../../../lib/api/stockMovements'
import type { ProductWarehouseStockRow } from '../../../lib/api/stockMovements'
import type { Brand, CartItem, Client, PosPoint, ProductCategory, SalesOrder, Warehouse } from '../../../types/domain'
import { OrderItemsEditor } from '../orders/OrderItemsEditor'
import { PaymentDrawer } from '../orders/PaymentDrawer'
import { ClientPickerCard } from '../clients/ClientPickerCard'
import { ConfirmDialog } from '@/components/organisms'
import { QuantityStepper } from '@/components/molecules'
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
export function PosTabAccount({
  tenantId,
  cartId,
  initialCart,
  points,
  onBack,
  onClosed,
}: {
  tenantId: string
  cartId: string
  /** Carrito recién creado por quien abre la pantalla (PosOpenTabs.handleCreate
   * ya lo trae completo de calculate-order) -- evita un getCart redundante
   * que bloqueaba el render con el spinner. Ausente = se lee del servidor. */
  initialCart?: CartWithItems
  points: PosPoint[]
  /** `pending`: guardado en segundo plano de "Volver", para refrescar el listado al terminar. */
  onBack: (pending?: Promise<unknown>) => void
  onClosed: () => void
}) {
  const { t, language } = useLanguage()
  const toast = useToast()
  const canCheckout = usePermission('pos.checkout')
  const receiptPrinter = usePosReceiptPrinter(tenantId)

  const [loaded, setLoaded] = useState(false)
  const [contactId, setContactId] = useState('')
  const [customer, setCustomer] = useState<Client | null>(null)
  const [posPointId, setPosPointId] = useState('')
  const [label, setLabel] = useState('')
  const [createdAt, setCreatedAt] = useState<string | null>(null)
  const [items, setItems] = useState<OrderItemInput[]>([])

  const [products, setProducts] = useState<ProductWithImages[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [stockRows, setStockRows] = useState<ProductWarehouseStockRow[]>([])
  // Estado del stock del listado: 'loading' -> 'ready' (o 'failed' si la
  // carga inicial falló). Mientras no esté 'ready' el editor no pinta "Agotado"
  // ni aplica tope (`stockLoading` de OrderItemsEditor: sin datos no se
  // bloquea nada). 'failed' avisa por toast y se reintenta solo cada 15 s
  // (y por foco/409), en vez de quedar así para siempre. Los faltantes que
  // vienen del servidor se ven siempre, en cualquier estado.
  const [stockStatus, setStockStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  // Refresco del stock del listado (tope de cantidad): sin esto, una caja que
  // repuso stock dejaría bloqueado a este cajero hasta reabrir la cuenta.
  const stockRefreshRef = useRef({ at: 0, inFlight: false })

  const [creditBalance, setCreditBalance] = useState(0)
  const [storeCreditBalance, setStoreCreditBalance] = useState(0)
  // Factura electrónica al cobrar (2026-09-08) -- todo lo nuevo de
  // facturación en PaymentDrawer queda inerte mientras esto sea false.
  // isDianDirectoConnected exige certificado + contraseña reales, NO solo
  // is_active=true -- ese campo defaultea a true en la fila apenas se toca
  // cualquier campo del drawer de Integraciones, mucho antes de terminar de
  // configurarla (bug real encontrado en vivo: un tenant sin certificado
  // subido ya veía el check acá).
  const [dianConnected, setDianConnected] = useState(false)

  // Falla al abrir la cuenta (getCart lanzó o devolvió null): pantalla de
  // error con reintento/volver en vez de spinner infinito.
  const [loadFailed, setLoadFailed] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Los errores de acciones (guardado, cobro, cerrar, cancelar...) salen por
  // toast (`toast.error`), no en un bloque inline: son transitorios.
  // "Volver" no bloquea: este ref solo evita disparar dos veces la salida (y su
  // guardado en segundo plano) con un doble clic antes de que se desmonte.
  const leavingRef = useRef(false)
  // Líneas que piden más de lo que hay en stock real -- las devuelve
  // calculate-order (nunca se calculan acá), por dos vías que no se pisan:
  // el preview de totales (`previewShortfalls`, abajo, corre también al abrir
  // una cuenta con productos ya cargados) y el guardado (`flushShortfalls`,
  // lo que devolvió el último flush). Mientras haya alguna: OrderItemsEditor
  // las pinta en rojo (prop `shortfalls`) y "Cobrar" queda deshabilitado --
  // el cajero tiene que borrar la línea o cambiarla de bodega para poder
  // seguir. Pedido explícito del usuario 2026-09-06.
  const [flushShortfalls, setFlushShortfallsState] = useState<StockShortfall[]>([])
  // Espejo síncrono de `flushShortfalls`: `handleChargeAll` lo lee después de
  // esperar guardados, cuando el estado del closure ya puede estar viejo.
  const flushShortfallsRef = useRef<StockShortfall[]>([])
  function setFlushShortfalls(next: StockShortfall[]) {
    flushShortfallsRef.current = next
    setFlushShortfallsState(next)
  }
  // Último snapshot sincronizado con el servidor: mismo valor que
  // `lastSyncedRef` pero como estado, para que el efecto de autoguardado se
  // re-evalúe cuando un guardado termina (un ref no vuelve a renderizar).
  const [syncedSnap, setSyncedSnap] = useState<string | null>(null)
  // Desglose que devolvió el último guardado (calculate-order lo trae desde
  // 2026-09-21) para EXACTAMENTE esos ítems: mientras las líneas en pantalla
  // sigan siendo esas, el resumen usa esto y no pide un preview aparte.
  const [prefetched, setPrefetched] = useState<PrefetchedTotals | null>(null)
  // Firma de las líneas de un guardado en vuelo: el preview de esas mismas
  // líneas espera a ese guardado (que trae los totales) en vez de duplicarlo.
  const [inflightItemsSig, setInflightItemsSig] = useState<string | null>(null)
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
  // Cobrar el saldo pendiente de un cargo ya hecho (pago parcial) sin salir
  // de esta pantalla -- antes la única forma era abrir el pedido en otra
  // pestaña o buscarlo en Órdenes, pedido explícito del usuario de
  // resolverlo ahí mismo. `getOrderBare` trae el pedido (PaymentDrawer
  // necesita el objeto entero, no solo el resumen de CartCharge) recién al
  // tocar "Agregar pago", nunca antes -- sin los joins de `getOrder`
  // (contacto/oportunidad/direcciones/perfil/punto de venta), que este
  // drawer no lee y que eran el motivo real de la demora reportada.
  const [payingCharge, setPayingCharge] = useState<{ order: SalesOrder; pendingAmount: number } | null>(null)
  const [payingChargeId, setPayingChargeId] = useState<string | null>(null)
  /** Cobro en curso: qué se va a cobrar y por cuánto. Abrir el drawer con
   * esto NO escribe nada -- el pedido se crea (y se confirma) recién cuando
   * el cajero registra el pago, ver createOrder en PaymentDrawer. Antes se
   * creaba acá, así que cerrar el drawer sin pagar dejaba la venta hecha y
   * la cuenta sin sus productos (bug reportado por el usuario). */
  const [pendingCharge, setPendingCharge] = useState<{ items?: { id: string; quantity: number }[]; totals: OrderTotalsBreakdown } | null>(null)
  // Idempotencia del cobro: un mismo uuid por cada apertura del drawer de
  // pago, reenviado tal cual en cada reintento de "Guardar" dentro de esa
  // MISMA apertura -- así un "Guardar" repetido tras un error (ej. falló el
  // registro del pago después de ya haber creado el pedido) retoma esa
  // fila en vez de crear un pedido duplicado. Se regenera en cada
  // handleCharge, nunca dentro de un mismo intento en curso.
  const chargeTokenRef = useRef<string | null>(null)

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
      .then(({ data }) => {
        setProducts(data)
        posOpenMark('catalogo-listo')
      })
      .catch(() => toast.error(t('pos.tabs.errors.loadCatalog', { what: t('pos.tabs.errors.loadCatalogProducts') })))
    listProductCategories(tenantId).then(setCategories).catch(() => {})
    listBrands(tenantId).then(setBrands).catch(() => {})
    listWarehouses(tenantId)
      .then(setWarehouses)
      .catch(() => toast.error(t('pos.tabs.errors.loadCatalog', { what: t('pos.tabs.errors.loadCatalogWarehouses') })))
    listStockByWarehouse(tenantId)
      .then((rows) => {
        stockRefreshRef.current.at = Date.now()
        setStockRows(rows)
        setStockStatus('ready')
      })
      .catch(() => {
        // Sin datos de stock: nada se bloquea por eso (ver stockStatus) y se reintenta solo.
        setStockStatus('failed')
        toast.error(t('pos.tabs.errors.loadCatalog', { what: t('pos.tabs.errors.loadCatalogStock') }))
      })
    isDianDirectoConnected(tenantId)
      .then(setDianConnected)
      .catch(() => setDianConnected(false))
  }, [tenantId])

  useEffect(() => {
    function applyCart(cart: CartWithItems) {
      setContactId(cart.contact_id ?? '')
      setPosPointId(cart.pos_point_id ?? '')
      setLabel(cart.label ?? '')
      setCreatedAt(cart.created_at)
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
    }
    if (initialCart && initialCart.id === cartId) {
      // Cuenta recién creada: ya la tenemos completa y sin cobros, no hay
      // nada que pedir al servidor antes de pintar.
      applyCart(initialCart)
      return
    }
    setLoadFailed(null)
    // Espera los guardados pendientes (p. ej. el de un "Volver" reciente) para
    // no leer líneas viejas ni un carrito a medio reescribir.
    waitForCartSaves(cartId)
      .then(() => getCart(cartId))
      .then((cart) => {
        // Sin carrito no hay nada que pintar: se avisa y se ofrece reintentar
        // o volver, en vez de dejar el spinner para siempre.
        if (!cart) {
          setLoadFailed(t('pos.tabs.errors.cartNotFound'))
          return
        }
        applyCart(cart)
      })
      .catch((err) => setLoadFailed(err instanceof Error && err.message ? err.message : t('pos.tabs.errors.loadCart')))
    listChargesFromCart(cartId).then(setCharges).catch(() => toast.error(t('pos.tabs.errors.loadCart')))
  }, [cartId, reloadKey])

  useEffect(() => {
    if (loaded) posOpenMark('cuenta-pintada')
  }, [loaded])

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
  // Cuántas líneas tenía el carrito la última vez que se corrió este efecto
  // -- para distinguir "se agregó un producto" (la cuenta creció) de
  // "se editó cantidad/precio de una línea que ya estaba".
  const prevItemCountRef = useRef(0)

  function snapshot(): string {
    return JSON.stringify({ contactId, posPointId, label, items })
  }
  // Snapshot de lo que hay en pantalla AHORA, para que un flush que resuelve
  // tarde sepa si lo que guardó todavía es lo actual (los closures de flush
  // ven el estado de cuando se lanzó).
  const currentSnapRef = useRef('')
  currentSnapRef.current = snapshot()

  // Solo el último guardado pedido puede escribir el estado -- mismo patrón
  // que requestRef en useOrderTotalsPreview. Sin esto, una respuesta lenta de
  // un guardado anterior pisa `lastSyncedRef`/los faltantes del actual y el
  // botón "Cobrar" queda con un estado que no corresponde a lo que hay en
  // pantalla.
  const flushIdRef = useRef(0)
  // Lo más reciente que hay en pantalla (snapshot + cuerpo del guardado). Un
  // guardado encolado lee esto cuando le toca correr, no lo que había al pedirlo.
  const latestRef = useRef<{ snap: string; input: SaveCartDraftInput } | null>(null)
  // Snapshot que el servidor rechazó por stock (409): el guardado de "Volver"
  // no lo reintenta (sería un segundo toast por el mismo error).
  const rejectedSnapRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  // Cerrando o cancelando la cuenta: el autoguardado se ignora (guardar sobre
  // una cuenta que se está cerrando/borrando solo produce un toast espurio).
  const windingRef = useRef(false)
  const winding = closing || cancelling
  windingRef.current = winding
  latestRef.current = { snap: currentSnapRef.current, input: { cart_id: cartId, contact_id: contactId, items, pos_point_id: posPointId || null, label: label || null } }
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** Vuelve a leer el stock del listado (silencioso: si falla se conserva el
   * que hay). `force` se salta el intervalo mínimo (tras un 409 de stock); el
   * refresco por foco de ventana respeta 30 s entre lecturas. */
  function refreshStock(force = false) {
    const state = stockRefreshRef.current
    if (!mountedRef.current || state.inFlight || (!force && Date.now() - state.at < 30_000)) return
    state.inFlight = true
    listStockByWarehouse(tenantId)
      .then((rows) => {
        state.at = Date.now()
        if (mountedRef.current) {
          setStockRows(rows)
          setStockStatus('ready')
        }
      })
      .catch(() => {})
      .finally(() => {
        state.inFlight = false
      })
  }
  const refreshStockRef = useRef(refreshStock)
  refreshStockRef.current = refreshStock
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') refreshStockRef.current()
    }
    const onFocus = () => refreshStockRef.current()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  // Carga inicial fallida: reintenta cada 15 s hasta lograrlo (silencioso; el
  // aviso ya salió una vez). Al quedar 'ready' el intervalo se limpia.
  useEffect(() => {
    if (stockStatus !== 'failed') return
    const timer = setInterval(() => refreshStockRef.current(true), 15_000)
    return () => clearInterval(timer)
  }, [stockStatus])

  /** Guarda el borrador y devuelve lo que calculó el servidor para
   * exactamente lo que se guardó: los faltantes de stock (handleChargeAll los
   * usa para no abrir el pago si hay alguno), esas mismas líneas y su
   * desglose de totales (null si el servidor no lo trae). */
  async function flush(): Promise<{ stockShortfalls: StockShortfall[]; items: OrderItemInput[]; totals: OrderTotalsBreakdown | null }> {
    const flushId = ++flushIdRef.current
    let snap = snapshot()
    let savedItems = items
    setInflightItemsSig(JSON.stringify(items))
    try {
      // Todos los guardados de la cuenta van en una sola cola (ver
      // enqueueCartSave): nunca hay dos en vuelo, y cada uno guarda lo más
      // reciente que haya en pantalla al momento de correr.
      const { stockShortfalls, totals: savedTotals } = await enqueueCartSave(cartId, () => {
        const latest = latestRef.current
        if (latest) {
          snap = latest.snap
          savedItems = latest.input.items
        }
        return saveCartDraft(latest ? latest.input : { cart_id: cartId, contact_id: contactId, items, pos_point_id: posPointId || null, label: label || null })
      })
      if (flushIdRef.current === flushId) {
        lastSyncedRef.current = snap
        setSyncedSnap(snap)
        // Si mientras tanto se editó, esos faltantes son de una versión vieja:
        // no se publican (el efecto de autoguardado vuelve a guardar lo actual).
        setFlushShortfalls(currentSnapRef.current === snap ? stockShortfalls : [])
        // Los totales quedan asociados a las líneas guardadas: el hook los usa
        // solo si siguen siendo las de la pantalla (si no, hace su preview).
        setPrefetched(savedTotals ? { items: savedItems, totals: savedTotals, stockShortfalls } : null)
      }
      return { stockShortfalls, items: savedItems, totals: savedTotals }
    } catch (err) {
      // El aviso sale SIEMPRE (aunque otro guardado lo haya superado): si no,
      // el clic de "Cobrar"/"Dividir" que no procede quedaría mudo. Única
      // excepción: la cuenta se está cerrando/cancelando (ver windingRef).
      if (err instanceof CartStockRejectedError) {
        rejectedSnapRef.current = snap
        // El tope se apoya en el stock del listado: si el servidor dice que no
        // alcanza, se vuelve a leer para que el tope refleje lo real.
        refreshStock(true)
      }
      if (!windingRef.current) {
        toast.error(
          err instanceof CartStockRejectedError
            ? t(mountedRef.current ? 'pos.tabs.errors.stockRejected' : 'pos.tabs.errors.stockRejectedOnLeave', { detail: err.message })
            : err instanceof Error
              ? err.message
              : t('pos.tabs.errors.save'),
        )
      }
      if (flushIdRef.current === flushId) {
        if (err instanceof CartStockRejectedError && err.cart && currentSnapRef.current === snap) {
          // El servidor NO guardó esa línea (stock insuficiente): la pantalla
          // vuelve al carrito tal como quedó allá, sin línea "fantasma", y
          // eso cuenta como sincronizado (no hay nada pendiente que reintentar).
          const serverItems: OrderItemInput[] = err.cart.items.map((i) => ({
            product_id: i.product_id,
            variant_id: i.variant_id,
            warehouse_id: i.warehouse_id,
            product_name: i.product_name,
            sku: i.sku,
            quantity: i.quantity,
            unit_price: i.unit_price,
            discount_amount: i.discount_amount,
          }))
          const revertedSnap = JSON.stringify({ contactId, posPointId, label, items: serverItems })
          prevItemCountRef.current = serverItems.length
          lastSyncedRef.current = revertedSnap
          // Los refs se actualizan ya (no al próximo render): un guardado o un
          // clic de "Cobrar" encolado que corra antes de repintar debe ver el
          // carrito revertido, no la línea rechazada.
          currentSnapRef.current = revertedSnap
          if (latestRef.current) latestRef.current = { snap: revertedSnap, input: { ...latestRef.current.input, items: serverItems } }
          setItems(serverItems)
          setSyncedSnap(revertedSnap)
          setFlushShortfalls([])
          setPrefetched(null)
        }
      }
      throw err
    } finally {
      if (flushIdRef.current === flushId) setInflightItemsSig(null)
    }
  }

  useEffect(() => {
    if (!loaded) return
    const snap = snapshot()
    if (!primedRef.current) {
      primedRef.current = true
      lastSyncedRef.current = snap
      setSyncedSnap(snap)
      prevItemCountRef.current = items.length
      return
    }
    if (snap === lastSyncedRef.current) return
    // Cerrando/cancelando la cuenta: no se autoguarda (toast espurio).
    if (winding) return
    // Un producto recién agregado (la cuenta creció) se guarda al instante
    // -- así el cajero ve de una si esa línea no cumple con el stock (roja +
    // "Cobrar" deshabilitado, ver stockShortfalls) en vez de enterarse 2s
    // después. Editar cantidad/precio de una línea que ya estaba sigue con
    // el debounce de siempre, para no guardar en cada tecla tipeada.
    const justAddedItem = items.length > prevItemCountRef.current
    prevItemCountRef.current = items.length
    const timer = setTimeout(
      () => {
        if (windingRef.current) return
        flush().catch(() => {})
      },
      justAddedItem ? 0 : 2000,
    )
    return () => clearTimeout(timer)
    // `syncedSnap` en las deps: si un guardado termina con un snapshot distinto
    // del actual (el cajero revirtió o siguió editando mientras volaba), el
    // efecto se re-evalúa y programa otro guardado. Sin bucle: cuando
    // syncedSnap === snapshot() el efecto retorna arriba, y un guardado fallido
    // no cambia syncedSnap (no reintenta solo; el clic en "Cobrar" reintenta).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, contactId, posPointId, label, items, syncedSnap, winding])

  // Desglose de la cuenta antes de cobrarla -- hasta ahora esta pantalla no
  // mostraba ningún total (el cajero solo veía las líneas), así que no había
  // forma de saber cuánto iba la mesa ni cuánto de eso era impuesto. Lo
  // calcula el servidor con las mismas reglas del pedido real, ver
  // useOrderTotalsPreview.
  const { totals, totalsSignature, stockShortfalls: previewShortfalls, loading: totalsLoading, error: totalsError } = useOrderTotalsPreview(items, 0, {
    prefetched,
    hold: inflightItemsSig !== null && inflightItemsSig === JSON.stringify(items),
  })
  // Lo último que muestra el resumen, con la firma de las líneas a las que
  // corresponde. Un clic de "Cobrar" que espera un guardado lo lee de acá, pero
  // SOLO lo usa si esa firma coincide con la de las líneas vigentes
  // (`latestRef`): este ref se escribe en el render y un 409 puede haber
  // revertido las líneas antes de que React repinte.
  const totalsRef = useRef<{ totals: OrderTotalsBreakdown | null; signature: string | null; error: string | null; shortfalls: StockShortfall[] }>({
    totals: null,
    signature: null,
    error: null,
    shortfalls: [],
  })
  totalsRef.current = { totals, signature: totalsSignature, error: totalsError, shortfalls: previewShortfalls }
  // Totales aptos para mostrar/imprimir "lo que hay ahora": solo si son de
  // estas mismas líneas (en el render entre una edición y el efecto del hook
  // `totals` todavía es el de las líneas anteriores).
  const currentTotals = totals && totalsSignature === orderTotalsSignature(items) ? totals : null
  // Al cambiar las líneas, lo que guardó el último guardado deja de valer (y
  // con él sus faltantes: si se vuelve a las mismas líneas, se calcula de nuevo).
  useEffect(() => {
    if (prefetched && orderTotalsSignature(prefetched.items) !== orderTotalsSignature(items)) setPrefetched(null)
  }, [items, prefetched])
  // Faltantes que se muestran: lo que devolvió el último guardado si hay
  // alguno, si no lo del preview (que corre también al abrir una cuenta con
  // productos ya cargados, sin esperar a una primera edición). Ambos vienen
  // de calculate-order; acá no se compara nada contra stock cacheado.
  const stockShortfalls = flushShortfalls.length > 0 ? flushShortfalls : previewShortfalls
  // "Cobrar"/"Dividir cuenta" no se bloquean mientras se sincroniza: el clic
  // espera el guardado pendiente (handleChargeAll/handleOpenSplit) y no abre
  // nada si el servidor devuelve faltantes; create-order/pos-checkout además
  // rechazan con 409 antes de insertar.

  /** Cerrar la mesa: acción propia, nunca un efecto de haber cobrado. Se
   * ofrece recién cuando la cuenta ya no tiene productos por cobrar --
   * mientras queden, o se cobran, o se descarta la cuenta entera con
   * "Cancelar cuenta". */
  async function handleClose() {
    windingRef.current = true
    setClosing(true)
    try {
      await waitForCartSaves(cartId)
      await closeCart(cartId)
      onClosed()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.tabs.errors.close'))
      windingRef.current = false
      setClosing(false)
      setConfirmingClose(false)
    }
  }

  /** Cierra la cuenta sola apenas queda en $0 -- sin productos por cobrar en
   * el carrito y sin ningún cargo con saldo pendiente, seguir mostrándola
   * en el listado de mesas abiertas no aporta nada (pedido explícito del
   * usuario). Mientras quede un cargo con saldo pendiente NO cierra sola --
   * mismo criterio de siempre ("cobrar no cierra la mesa"), ahora resuelto
   * ahí mismo con "Agregar pago" (ver handleOpenChargePayment) en vez de
   * obligar a salir a Órdenes. `cartItemCount` se recibe como parámetro (no
   * se lee del estado `items`) porque justo después de cobrar ese estado
   * todavía no se actualizó -- usar el array recién releído del servidor
   * evita decidir con un conteo viejo. */
  async function closeIfFullyPaid(cartItemCount: number, freshCharges: CartCharge[]) {
    const fullyPaid = freshCharges.length > 0 && freshCharges.every((c) => c.total - c.paid <= 0)
    if (cartItemCount === 0 && fullyPaid) {
      await closeCart(cartId).catch(() => {})
      onClosed()
    }
  }

  const posPointName = points.find((p) => p.id === posPointId)?.name ?? null

  async function handleCancel() {
    windingRef.current = true
    setCancelling(true)
    try {
      await waitForCartSaves(cartId)
      await deleteCart(cartId)
      onClosed()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.tabs.errors.cancel'))
      windingRef.current = false
      setCancelling(false)
      setConfirmingCancel(false)
    }
  }

  /** Abre el pago del saldo pendiente de un cargo ya hecho (pago parcial)
   * sin salir de esta pantalla -- antes había que abrir el pedido en otra
   * pestaña o buscarlo en Órdenes. Trae el pedido recién acá (PaymentDrawer
   * necesita el objeto entero, CartCharge es solo un resumen) con
   * `getOrderBare` -- sin joins, el fetch más barato posible antes de abrir
   * el drawer. */
  async function handleOpenChargePayment(charge: CartCharge) {
    setPayingChargeId(charge.id)
    try {
      const order = await getOrderBare(charge.id)
      if (!order) throw new Error(t('pos.tabs.errors.loadOrder'))
      setPayingCharge({ order, pendingAmount: charge.total - charge.paid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.tabs.errors.loadOrder'))
    } finally {
      setPayingChargeId(null)
    }
  }

  async function handleCharge(selectedItems?: { id: string; quantity: number }[], saved?: { items: OrderItemInput[]; totals: OrderTotalsBreakdown | null }) {
    setCharging(true)
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
        : // `saved`: lo que devolvió el guardado que acaba de esperar
          // handleChargeAll (sus ítems y su desglose), no lo que había en
          // pantalla al hacer clic -- si el servidor quitó una línea por stock,
          // el pago abre con el estado real de la cuenta.
          (saved?.totals ?? (await previewOrderTotals(saved?.items ?? latestRef.current?.input.items ?? items)))
      setSplitItems(null)
      drawerDoneRef.current = false
      chargeTokenRef.current = crypto.randomUUID()
      setPendingCharge({ items: selectedItems, totals: chargeTotals })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.tabs.errors.charge'))
    } finally {
      setCharging(false)
    }
  }

  async function handleChargeAll() {
    setCharging(true)
    let saved: { items: OrderItemInput[]; totals: OrderTotalsBreakdown | null } | undefined
    try {
      // Primero espera el guardado que esté en vuelo (p. ej. el autoguardado
      // de la línea recién agregada, que puede volver con un 409): decidir
      // antes dejaba abrir el pago con la línea que el servidor iba a rechazar.
      await waitForCartSaves(cartId)
      // Solo re-guarda si quedó algo sin sincronizar -- el caso común (cajero
      // agrega productos, espera un toque, recién ahí cobra) ya está guardado,
      // forzar un viaje de red extra ahí no suma nada más que lentitud.
      if (currentSnapRef.current !== lastSyncedRef.current) {
        // Si el servidor devuelve faltantes para lo que se acaba de guardar,
        // no se abre el pago: quedan en rojo (flush los deja en estado).
        const result = await flush()
        if (result.stockShortfalls.length > 0) {
          toast.error(t('pos.tabs.errors.stockShortfall'))
          setCharging(false)
          return
        }
        saved = { items: result.items, totals: result.totals }
      } else {
        // Ya sincronizado: se cobra con lo vigente (los refs, no el closure
        // del clic, que puede ser de antes de un guardado que acaba de volver).
        // Los totales de pantalla se usan solo si son de EXACTAMENTE esas
        // líneas; si no (p. ej. un 409 acaba de revertir la cuenta y React no
        // repintó), handleCharge pide el desglose fresco de las líneas vigentes.
        const current = totalsRef.current
        const liveItems = latestRef.current?.input.items ?? items
        // Faltantes que el servidor ya informó para estas líneas, sea en un
        // guardado que resolvió mientras se esperaba (sin 409) o en el preview
        // de exactamente estas líneas: no se abre el pago, igual que en la
        // rama con guardado.
        const knownShortfalls = flushShortfallsRef.current.length > 0 ? flushShortfallsRef.current : current.signature === orderTotalsSignature(liveItems) ? current.shortfalls : []
        if (knownShortfalls.length > 0) {
          toast.error(t('pos.tabs.errors.stockShortfall'))
          setCharging(false)
          return
        }
        saved = {
          items: liveItems,
          totals: current.totals && !current.error && current.signature === orderTotalsSignature(liveItems) ? current.totals : null,
        }
      }
    } catch {
      // flush ya avisó por toast.
      setCharging(false)
      return
    }
    await handleCharge(undefined, saved)
  }

  /** Abre el selector de "dividir cuenta" -- primero flushea si hace
   * falta y recién ahí relee el carrito del servidor, porque una línea
   * agregada hace instantes puede no tener id propio todavía en el
   * estado local. */
  async function handleOpenSplit() {
    setOpeningSplit(true)
    try {
      if (currentSnapRef.current !== lastSyncedRef.current) {
        let result: Awaited<ReturnType<typeof flush>>
        try {
          result = await flush()
        } catch {
          // flush ya avisó por toast: no repetirlo acá.
          return
        }
        if (result.stockShortfalls.length > 0) {
          toast.error(t('pos.tabs.errors.stockShortfall'))
          return
        }
      }
      await waitForCartSaves(cartId)
      const cart = await getCart(cartId)
      if (!cart) throw new Error(t('pos.tabs.errors.save'))
      setSplitItems(cart.items)
      setSelectedQuantities(new Map(cart.items.map((i) => [i.id, i.quantity])))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.tabs.errors.save'))
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

  /** Se llama al salir del drawer de pago, se haya registrado el pago o no.
   * Releer es obligatorio en los DOS casos: los ítems que se acaban de
   * cobrar ya salieron del carrito del lado del servidor, así que si el
   * estado local se quedara con ellos el autoguardado los volvería a
   * insertar en la cuenta y se cobrarían dos veces. Si no quedó nada Y no
   * hay ningún cargo con saldo pendiente, la cuenta se cierra sola
   * (closeIfFullyPaid); si queda algo por cobrar -- productos sin cobrar, o
   * un cargo con saldo pendiente -- sigue abierta e igual de usable.
   * `allowAutoClose=false` cuando este cobro pidió factura electrónica y la
   * DIAN la rechazó (o el envío falló) -- la cuenta se queda abierta y
   * visible a propósito, para que el cajero vea el error ahí mismo en vez
   * de que la pantalla navegue afuera sola. */
  async function handlePaymentDrawerDone(allowAutoClose = true) {
    // PaymentDrawer llama onSaved() y acto seguido onClose() al guardar --
    // ambos apuntan acá, así que sin esta guarda se releería el carrito dos
    // veces por el mismo cobro.
    if (drawerDoneRef.current) return
    drawerDoneRef.current = true
    setPendingCharge(null)
    const [cart, freshCharges] = await Promise.all([getCart(cartId).catch(() => null), listChargesFromCart(cartId).catch(() => [] as CartCharge[])])
    setCharges(freshCharges)
    if (!cart) return
    // Vuelve a "primer render" para el autosave -- este es el nuevo estado
    // base recién leído del servidor, no una edición pendiente que haya que
    // volver a guardar (snapshot() todavía vería el `items` de antes de
    // este setItems, React no lo actualiza en el momento).
    primedRef.current = false
    setFlushShortfalls([])
    setPrefetched(null)
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
    if (allowAutoClose) await closeIfFullyPaid(cart.items.length, freshCharges)
  }

  /** Volver: sale de inmediato. Si hay una edición sin sincronizar (el
   * debounce de 2 s se cancela al desmontar), la guarda en segundo plano con
   * el snapshot de este momento -- sin depender de estado del componente, que
   * ya no va a existir -- y si falla avisa por toast (el ToastProvider vive en
   * la raíz). Se le pasa la promesa a onBack para que el listado se refresque
   * cuando termine. */
  function handleBack() {
    if (leavingRef.current) return
    leavingRef.current = true
    if (snapshot() === lastSyncedRef.current) {
      onBack()
      return
    }
    const snap = snapshot()
    const input = { cart_id: cartId, contact_id: contactId, items, pos_point_id: posPointId || null, label: label || null }
    // Misma cola que el resto de guardados de la cuenta: corre cuando termine
    // el que esté en vuelo, y si para entonces ya quedó guardado (o el servidor
    // ya rechazó exactamente esto por stock) no repite ni vuelve a avisar.
    const background = enqueueCartSave(cartId, async () => {
      if (lastSyncedRef.current === snap || rejectedSnapRef.current === snap) return
      try {
        await saveCartDraft(input)
      } catch (err) {
        toast.error(err instanceof CartStockRejectedError ? t('pos.tabs.errors.stockRejectedOnLeave', { detail: err.message }) : t('pos.tabs.errors.saveBeforeBack'))
      }
    })
    onBack(background)
  }

  if (loadFailed) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-red-700">{loadFailed}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.actions.retry')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onBack()}>
            {t('pos.tabs.backToList')}
          </Button>
        </div>
      </div>
    )
  }

  if (!loaded) return <PageSpinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={handleBack} className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:text-brand-700">
          <ChevronLeftIcon width={14} height={14} /> {t('pos.tabs.backToList')}
        </button>
        {createdAt && (
          <p className="text-[11px] text-brand-400">
            {t('pos.tabs.openedAt')} {formatDate(createdAt)} · {formatTime(createdAt, language)}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <OrderItemsEditor
            items={items}
            products={products}
            categories={categories}
            brands={brands}
            warehouses={warehouses}
            stockRows={stockRows}
            shortfalls={stockShortfalls}
            searchAlwaysOpen
            stockLoading={stockStatus !== 'ready'}
            onChange={(next) => {
              setFlushShortfalls([])
              setItems(next)
            }}
          />

          {/* Lo ya cobrado de esta mesa. Sin esto, después de cobrar la
              cuenta quedaba abierta y vacía y no había forma de saber qué
              se había llevado: los productos cobrados salen del carrito (que
              solo lleva lo pendiente) y pasan a vivir en su pedido, así que
              este es el único lugar donde el cajero los vuelve a ver, con su
              estado de pago. */}
          {charges.length > 0 && (
            <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-brand-800">{t('pos.tabs.charges.title')}</h3>
                <span className="text-xs font-bold text-brand-800">{formatCurrency(charges.reduce((sum, c) => sum + c.total, 0), charges[0]?.currency)}</span>
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
                          <span className="text-xs font-semibold text-brand-800">{formatCurrency(charge.total, charge.currency)}</span>
                        </span>
                      </div>
                      {pending > 0 && (
                        <div className="mt-1 flex justify-end">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => handleOpenChargePayment(charge)}
                            disabled={payingChargeId === charge.id}
                          >
                            {payingChargeId === charge.id ? t('common.actions.loading') : t('pos.tabs.charges.addPayment')}
                          </Button>
                        </div>
                      )}
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
          <ClientPickerCard
            tenantId={tenantId}
            client={customer}
            onSelect={(c) => setContactId(c?.id ?? '')}
            onSearch={(q) => searchPosClients(tenantId, q)}
            emptyLabel={t('pos.customer.walkIn')}
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
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-brand-500 uppercase">{t('pos.totals.title')}</h3>
              {/* Imprimir lo que ya está cargado en la mesa, sin necesidad de
                  cobrar primero -- pedido explícito del usuario. Nunca es el
                  mismo ticket que el del cobro final: acá no hay pedido ni
                  pago todavía (PosPendingReceiptTicket, nunca "factura de
                  venta"). */}
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() =>
                  receiptPrinter.printPending(
                    items.map((i) => ({ product_name: i.product_name, sku: i.sku ?? null, quantity: i.quantity, subtotal: i.quantity * i.unit_price - (i.discount_amount ?? 0) })),
                    currentTotals ?? {
                      tax_enabled: false,
                      subtotal: items.reduce((sum, i) => sum + i.quantity * i.unit_price - (i.discount_amount ?? 0), 0),
                      discount_total: 0,
                      taxable_base: items.reduce((sum, i) => sum + i.quantity * i.unit_price - (i.discount_amount ?? 0), 0),
                      tax_total: 0,
                      shipping: 0,
                      total: items.reduce((sum, i) => sum + i.quantity * i.unit_price - (i.discount_amount ?? 0), 0),
                      tax_lines: [],
                    },
                    { posPointName, customerName: customer?.full_name ?? null },
                  )
                }
                disabled={items.length === 0 || receiptPrinter.printing}
                aria-label={t('pos.receipt.printPending')}
                title={t('pos.receipt.printPending')}
              >
                <PrinterIcon width={13} height={13} />
              </Button>
            </div>
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

          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={handleBack}>
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
            <>
              {stockShortfalls.length > 0 && <p className="mb-2 text-center text-xs font-medium text-red-600">{t('pos.tabs.errors.stockShortfall')}</p>}
              <Button type="button" size="lg" className="w-full" disabled={!canCheckout || charging || stockShortfalls.length > 0} onClick={handleChargeAll}>
                {charging ? t('pos.actions.charging') : t('pos.tabs.charge')}
              </Button>
            </>
          )}
          {(items.length > 1 || items.some((i) => i.quantity > 1)) && (
            <button
              type="button"
              onClick={handleOpenSplit}
              disabled={!canCheckout || openingSplit || charging || stockShortfalls.length > 0}
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
          onClose={() => handlePaymentDrawerDone()}
          tenantId={tenantId}
          order={null}
          totals={pendingCharge.totals}
          pendingAmount={pendingCharge.totals.total}
          createOrder={(buyerContactId) =>
            createOrderFromCart(cartId, pendingCharge.items, {
              keepCartOpen: true,
              confirm: true,
              checkoutToken: chargeTokenRef.current ?? undefined,
              buyerContactId,
            })
          }
          creditEnabled={customer?.credit_enabled ?? false}
          storeCreditBalance={storeCreditBalance}
          dianConnected={dianConnected}
          defaultBuyer={customer}
          onSearchBuyers={(q) => searchPosClients(tenantId, q)}
          onSaved={(chargedOrder, einvoicing) => {
            if (einvoicing?.error) toast.error(einvoicing.error)
            if (receiptPrinter.autoPrintEnabled) receiptPrinter.print(chargedOrder.id, posPointName)
            handlePaymentDrawerDone(!einvoicing?.error)
          }}
        />
      )}

      {/* Saldo pendiente de un cargo ya hecho (pago parcial) -- ver
          handleOpenChargePayment. A diferencia del drawer de arriba, acá
          el pedido ya existe (`order`, no `createOrder`): registrar el
          pago no crea nada nuevo, solo suma el pago que falta -- ni el
          comprador de la factura se puede elegir acá (ya quedó fijo cuando
          se creó el pedido), PaymentDrawer no muestra ese selector cuando
          `order` no es null. */}
      {payingCharge && (
        <PaymentDrawer
          open
          onClose={() => setPayingCharge(null)}
          tenantId={tenantId}
          order={payingCharge.order}
          pendingAmount={payingCharge.pendingAmount}
          creditEnabled={customer?.credit_enabled ?? false}
          storeCreditBalance={storeCreditBalance}
          dianConnected={dianConnected}
          onSaved={async (_order, einvoicing) => {
            setPayingCharge(null)
            if (einvoicing?.error) toast.error(einvoicing.error)
            const freshCharges = await listChargesFromCart(cartId).catch(() => [] as CartCharge[])
            setCharges(freshCharges)
            if (!einvoicing?.error) await closeIfFullyPaid(items.length, freshCharges)
          }}
        />
      )}

      {/* Dividir cuenta -- selección de qué productos van en este cobro,
          el resto se queda en la misma cuenta abierta. Ver handleOpenSplit. */}
      {splitItems && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSplitItems(null)}>
          <div className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-brand-800">{t('pos.tabs.splitBillTitle')}</h3>
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
                      <QuantityStepper
                        value={qty}
                        onChange={(v) => setSplitQuantity(item, v)}
                        max={item.quantity}
                        decreaseLabel={t('common.actions.decreaseQuantity')}
                        increaseLabel={t('common.actions.increaseQuantity')}
                        className="w-24 shrink-0"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-brand-800">{item.product_name}</span>
                      <span className="block text-xs text-brand-400">
                        {item.quantity > 1 ? `${qty}/${item.quantity} · ` : ''}
                        {formatCurrency(item.unit_price)} c/u
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-brand-800">{formatCurrency(lineTotal)}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-brand-100 pt-3 text-xs">
              <span className="text-brand-500">{t('pos.tabs.splitSelectedTotal')}</span>
              <span className="font-bold text-brand-800">{formatCurrency(splitSelectedTotal)}</span>
            </div>
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
