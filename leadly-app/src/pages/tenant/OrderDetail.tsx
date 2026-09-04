import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DownloadIcon, RefreshCwIcon, ScanLineIcon, UploadIcon, XIcon } from 'lucide-react'
import {
  calculateOrder,
  deleteOrder,
  findStockShortfalls,
  getOrder,
  hasIncompleteVariantSelection,
  listOrderItems,
  updateOrderStatus,
  updateDeliveryStatus,
  ORDER_STATUS_LABEL_KEY,
  ORDER_STATUS_BADGE_CLASS,
  DELIVERY_STATUS_LABEL_KEY,
} from '../../lib/api/orders'
import type { OrderDetail as OrderDetailType, OrderItemInput, StockShortfall } from '../../lib/api/orders'
import { listClients } from '../../lib/api/clients'
import type { Client } from '../../types/domain'
import { listOpportunities } from '../../lib/api/opportunities'
import type { OpportunityWithRelations } from '../../lib/api/opportunities'
import { listAddressesForContact } from '../../lib/api/addresses'
import { listProducts } from '../../lib/api/products'
import type { ProductWithImages } from '../../lib/api/products'
import { listStockByWarehouse } from '../../lib/api/stockMovements'
import type { ProductWarehouseStockRow } from '../../lib/api/stockMovements'
import { listProductCategories } from '../../lib/api/productCategories'
import { listBrands } from '../../lib/api/brands'
import { listWarehouses } from '../../lib/api/warehouses'
import { listPaymentsForOrder, deletePayment, PAYMENT_METHOD_LABEL_KEY } from '../../lib/api/orderPayments'
import { getLatestSalesInvoiceForOrder, getSalesOrderPdf, sendSalesInvoiceToDian, retrySalesInvoiceToDian } from '../../lib/api/salesInvoices'
import type { SalesInvoice, SalesInvoiceStatus } from '../../types/domain'
import { listCommentsForOrder, createComment } from '../../lib/api/orderComments'
import type { OrderCommentWithAuthor } from '../../lib/api/orderComments'
import { listTasksForOpportunity } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import type { ContactAddress, SalesOrderPayment, OrderStatus, DeliveryStatus, ProductCategory, Brand, Warehouse } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { isNotBlank } from '../../lib/validation'
import { formatDate, formatDateTime } from '../../lib/dates'
import { formatClientPhoneDisplay } from '../../lib/phone'
import { FieldError, InitialsAvatar, PageSpinner } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { ClockIcon, PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { OrderItemsEditor } from './orders/OrderItemsEditor'
import { PaymentDrawer } from './orders/PaymentDrawer'
import { DispatchDrawer } from './orders/DispatchDrawer'
import { getDispatchStatusForOrder, type DispatchStatusSummary } from '../../lib/api/dispatches'
import { getStoreCreditBalance } from '../../lib/api/returns'
import { StockShortfallDialog } from './orders/StockShortfallDialog'
import { AddressDrawer } from './clients/AddressDrawer'

function addressLabel(a: ContactAddress): string {
  return `${a.label ? `${a.label} — ` : ''}${a.line1}${a.city ? `, ${a.city}` : ''}`
}

/** Only relevant at creation -- 'cancelada' isn't offered (a brand new
 * order can't start already voided), and once it exists, edit mode moves
 * status forward through the header buttons instead of a select (see
 * statusActions below). */
const CREATE_STATUS_OPTIONS: OrderStatus[] = ['cotizacion', 'confirmada']

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** El impuesto de línea puede quedar con decimales reales (ej. INC 8%
 * sobre $38.000 = $2.814,81) -- a diferencia del resto de la app, que
 * redondea al peso entero, acá se muestran los 2 decimales a propósito
 * (mismo criterio de la DIAN, que trunca a 2 decimales para el CUFE/CUDE,
 * ver cufe.ts). */
function formatCurrencyPrecise(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

const INVOICE_STATUS_VARIANT: Record<SalesInvoiceStatus, string> = {
  pending: 'bg-brand-100 text-brand-600',
  blocked_missing_buyer_data: 'bg-amber-100 text-amber-700',
  generating: 'bg-blue-100 text-blue-700',
  generated: 'bg-blue-100 text-blue-700',
  sending: 'bg-blue-100 text-blue-700',
  sent: 'bg-blue-100 text-blue-700',
  accepted: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  error: 'bg-red-100 text-red-700',
  voided: 'bg-brand-100 text-brand-500',
}


/** Same card shape as ProductDetail.tsx (title + optional header action +
 * content) -- not extracted to a shared component since this is only its
 * second local copy in the codebase (ProductDetail.tsx has the first);
 * a third page adopting the same shape would be the point to share it. */
function StatCard({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-brand-100 p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-brand-800">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}

/** Same pill used across the CRM (ClientDetail.tsx, and the old
 * OrderDetail.tsx) to mark something the AI created on its own. */
function AiBadge({ label }: { label: string }) {
  return <span className="shrink-0 rounded-full bg-accent-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-700">{label}</span>
}

/** One half of the "4. Notas y comentarios" card -- Notas and Comentarios
 * are the same shape (content + author + date, newest first, like a
 * conversation) since both now live in sales_order_comments split by
 * is_internal (ver types/domain.ts), so this covers both instead of
 * duplicating the list markup. Only the add-form is passed in as `form`.
 *
 * Ninguno de los dos hilos admite adjuntar archivos -- Comentarios tenía un
 * selector de imagen que se quitó a pedido explícito del usuario
 * (2026-09-04); un comentario es texto que va impreso en la factura, no un
 * repositorio de archivos. */
function ThreadColumn({
  label,
  entries,
  adding,
  onToggleAdd,
  addAria,
  form,
}: {
  label: string
  entries: OrderCommentWithAuthor[] | null
  adding: boolean
  onToggleAdd: () => void
  addAria: string
  form: ReactNode
}) {
  const { t, language } = useLanguage()
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <Button type="button" variant="default" size="icon-sm" onClick={onToggleAdd} aria-label={addAria}>
          {adding ? <XIcon className="size-3.5" /> : <PlusIcon width={13} height={13} />}
        </Button>
      </div>
      {adding && <div className="mb-2">{form}</div>}
      {!entries && <PageSpinner />}
      {entries && entries.length === 0 && !adding && <p className="text-xs text-brand-400">{t('orders.detail.threadEmpty')}</p>}
      {entries && entries.length > 0 && (
        <ul className="max-h-56 space-y-2.5 overflow-y-auto">
          {entries.map((c) => (
            <li key={c.id} className="flex items-start gap-2">
              <InitialsAvatar name={c.created_by_ai ? t('orders.detail.aiBadge') : (c.author?.full_name ?? t('orders.detail.agent'))} size="xs" />
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm text-brand-700">{c.content}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-brand-400">
                  {c.created_by_ai ? t('orders.detail.aiAssistant') : (c.author?.full_name ?? t('orders.detail.agent'))} · {formatDateTime(c.created_at, language)}
                  {c.created_by_ai && <AiBadge label={t('orders.detail.aiBadge')} />}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { profile, enabledModules } = useAuth()
  const { t, language } = useLanguage()
  const isNew = !id

  // ----- loaded order (edit mode only) -----
  const [order, setOrder] = useState<OrderDetailType | null | undefined>(isNew ? null : undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // ----- reference data (both modes) -----
  const [contacts, setContacts] = useState<Client[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[]>([])
  const [products, setProducts] = useState<ProductWithImages[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [stockRows, setStockRows] = useState<ProductWarehouseStockRow[]>([])
  const [addresses, setAddresses] = useState<ContactAddress[]>([])
  const [relatedTasks, setRelatedTasks] = useState<TaskWithRelations[] | null>(null)

  // ----- editable fields, shared shape for both modes -----
  const [contactId, setContactId] = useState(() => searchParams.get('contactId') ?? '')
  const [opportunityId, setOpportunityId] = useState('')
  // Ventas directas son el caso por defecto (pedido explícito del usuario:
  // "por defecto deben ser ventas, cotizaciones [son] algo adicional que
  // requiera") -- Cotización sigue siendo una opción real en el Select de
  // Estado, solo dejó de ser el estado inicial al crear.
  const [status, setStatus] = useState<OrderStatus>('confirmada')
  const [validUntil, setValidUntil] = useState('')
  const [shippingAddressId, setShippingAddressId] = useState('')
  const [billingAddressId, setBillingAddressId] = useState('')
  const [contactChangedNotice, setContactChangedNotice] = useState(false)
  // Contacto shows either the search combobox or (once picked) a compact
  // read-only card with its info -- the "x" on the card switches back to
  // the combobox instead of clearing contact_id outright (required field,
  // see handleContactSelect's guard against nulling it on an existing
  // order); the combobox itself is rendered with value=null while in this
  // mode so it doesn't show its own redundant "x" on top of the old pick.
  const [editingContact, setEditingContact] = useState(false)
  // Same toggle idea as editingContact, one per address role -- picking a
  // different saved address (or clearing to search) shouldn't require the
  // field to look like a dropdown all the time (explicit user feedback,
  // reference screenshot: address shows as plain text, edit is a separate
  // small action).
  const [editingShippingAddress, setEditingShippingAddress] = useState(false)
  const [editingBillingAddress, setEditingBillingAddress] = useState(false)
  const [touched, setTouched] = useState(false)

  // ----- items + shipping: guardado automático centralizado, ver el
  // useEffect de "autosave" más abajo. Nada de esto se calcula en el
  // frontend (ni subtotal, ni impuesto, ni total) -- calculate-order
  // (Edge Function) es la única fuente de verdad; itemsLoaded existe solo
  // para saber cuándo ya se cargó el estado real del pedido y recién ahí
  // empezar a tratar cambios como ediciones del agente (ver comentario
  // grande en el useEffect de autosave). -----
  const [items, setItems] = useState<OrderItemInput[]>([])
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const [shippingDraft, setShippingDraft] = useState('0')
  const [savingDraft, setSavingDraft] = useState(false)

  // ----- creation -----
  const [creating, setCreating] = useState(false)

  // ----- payments / notes+comments (edit mode only) -----
  const [payments, setPayments] = useState<SalesOrderPayment[] | null>(null)
  // Both threads live in the same table now (sales_order_comments.is_internal
  // splits them, ver types/domain.ts) -- one fetch, filtered client-side into
  // the two columns (see notesList/commentsList below).
  const [comments, setComments] = useState<OrderCommentWithAuthor[] | null>(null)
  // Each column's "+" reveals its own form instead of always showing one --
  // explicit user feedback, matches the reference screenshot's collapsed
  // "Comentarios [+]" / "Observaciones [+]" boxes.
  const [addingNote, setAddingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [addingComment, setAddingComment] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [savingComment, setSavingComment] = useState(false)
  const [paymentDrawerOpen, setPaymentDrawerOpen] = useState(false)
  const [dispatchDrawerOpen, setDispatchDrawerOpen] = useState(false)
  const [dispatchStatus, setDispatchStatus] = useState<DispatchStatusSummary | null>(null)

  // ----- Factura DIAN (módulo 'einvoicing') -- vive DENTRO del pedido, no en
  // una lista propia (feedback explícito del usuario 2026-09-03: comprador/
  // vendedor/ítems ya se ven acá arriba, no tiene sentido una pantalla
  // aparte que los repita solo para mostrar el estado y el botón de envío).
  // Solo interesa el intento VIGENTE: o la factura fue aceptada por la DIAN
  // o no lo fue, y en ese caso por qué. El historial de reintentos se sigue
  // guardando en la base (son registros fiscales) pero no se muestra
  // -- feedback explícito del usuario 2026-09-03: "¿para qué me sirve
  // guardar los reintentos? ese dato no es útil".
  const [latestInvoice, setLatestInvoice] = useState<SalesInvoice | null>(null)
  const [sendingInvoice, setSendingInvoice] = useState(false)
  const [sendInvoiceError, setSendInvoiceError] = useState<string | null>(null)
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<string | null>(null)
  const [invoicePdfError, setInvoicePdfError] = useState<string | null>(null)

  function reloadInvoices() {
    if (!order?.id || !enabledModules?.has('einvoicing')) {
      setLatestInvoice(null)
      return
    }
    getLatestSalesInvoiceForOrder(order.id)
      .then(setLatestInvoice)
      .catch(() => setLatestInvoice(null))
  }

  useEffect(() => {
    reloadInvoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, enabledModules])

  /** Envío del intento vigente, o reintento si ese intento ya fracasó. El
   * reintento no reescribe la factura rechazada: el servidor crea un intento
   * nuevo (attempt_number+1) y envía ése, por eso en ambos casos hace falta
   * releer el listado -- después de un reintento hay una fila MÁS, no una
   * modificada. */
  async function handleSendInvoice(retry = false) {
    if (!latestInvoice) return
    setSendingInvoice(true)
    setSendInvoiceError(null)
    try {
      const result = retry ? await retrySalesInvoiceToDian(latestInvoice.id) : await sendSalesInvoiceToDian(latestInvoice.id)
      if (result.status === 'error') setSendInvoiceError(result.faultReason ?? t('einvoicing.detail.sendError'))
      reloadInvoices()
    } catch (err) {
      setSendInvoiceError(err instanceof Error ? err.message : t('einvoicing.detail.sendError'))
    } finally {
      setSendingInvoice(false)
    }
  }

  /** Abre la representación gráfica de UN intento puntual en una pestaña
   * nueva (visor de PDF del navegador) en vez de forzar una descarga
   * directa -- el usuario pidió poder "verla", no solo bajar un archivo. El
   * Blob URL queda vivo mientras esa pestaña esté abierta; no hace falta
   * revocarlo acá.
   *
   * La pestaña se abre EN BLANCO acá mismo, antes de cualquier `await` --
   * un `window.open` después de esperar la respuesta del servidor ya no
   * cuenta como parte del gesto de click para el bloqueador de pop-ups del
   * navegador, y se descarta en silencio sin tirar ningún error (bug real
   * encontrado al probar: el botón terminaba su ciclo de carga normal,
   * pero nunca aparecía ninguna pestaña nueva). */
  async function handleDownloadInvoicePdf() {
    if (!id) return
    const pendingTab = window.open('', '_blank')
    setDownloadingInvoiceId(id)
    setInvoicePdfError(null)
    try {
      const { pdfBase64 } = await getSalesOrderPdf(id)
      const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      if (pendingTab) pendingTab.location.href = url
      else window.open(url, '_blank')
    } catch (err) {
      pendingTab?.close()
      setInvoicePdfError(err instanceof Error ? err.message : t('einvoicing.detail.pdfError'))
    } finally {
      setDownloadingInvoiceId(null)
    }
  }

  function reloadDispatchStatus() {
    if (!order || !enabledModules?.has('dispatches')) return
    getDispatchStatusForOrder(order.id)
      .then(setDispatchStatus)
      .catch(() => setDispatchStatus(null))
  }

  useEffect(() => {
    reloadDispatchStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, enabledModules])

  // Redimir saldo a favor en PaymentDrawer (ver returns.md) necesita saber
  // cuánto tiene disponible el cliente de esta orden -- se recarga cada vez
  // que cambia el contacto, no solo al montar, porque "Cambiar contacto" es
  // una acción real acá (ver handleContactSelect).
  const [storeCreditBalance, setStoreCreditBalance] = useState(0)

  useEffect(() => {
    if (!order?.contact_id) {
      setStoreCreditBalance(0)
      return
    }
    getStoreCreditBalance(order.contact_id).then(setStoreCreditBalance).catch(() => setStoreCreditBalance(0))
  }, [order?.contact_id])

  const [addressDrawerOpen, setAddressDrawerOpen] = useState(false)
  const [deletePaymentId, setDeletePaymentId] = useState<string | null>(null)
  const [confirmingVoid, setConfirmingVoid] = useState(false)
  // Estado de envío elegido mientras el pedido tiene saldo pendiente -- ver
  // handleDeliveryStatusSelect/applyDeliveryStatus. null = sin diálogo
  // abierto.
  const [pendingDeliveryStatus, setPendingDeliveryStatus] = useState<DeliveryStatus | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [advancingStatus, setAdvancingStatus] = useState(false)
  // stockShortfalls persists after the dialog closes (it drives the red
  // outline on the offending Cantidad inputs in OrderItemsEditor) --
  // shortfallDialogOpen is the only thing the dialog itself reads.
  const [stockShortfalls, setStockShortfalls] = useState<StockShortfall[]>([])
  const [shortfallDialogOpen, setShortfallDialogOpen] = useState(false)

  function reloadOrder() {
    if (!id) return
    getOrder(id)
      .then(setOrder)
      .catch((err) => setLoadError(err.message ?? t('orders.detail.loadError')))
  }

  function reloadItems() {
    if (!id) return
    listOrderItems(id).then((data) => {
      const mapped = data.map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id,
        warehouse_id: i.warehouse_id,
        product_name: i.product_name,
        sku: i.sku,
        quantity: i.quantity,
        unit_price: i.unit_price,
        discount_amount: i.discount_amount,
      }))
      setItems(mapped)
      setItemsLoaded(true)
    })
  }

  function reloadPayments() {
    if (!id) return
    listPaymentsForOrder(id).then(setPayments).catch(() => setPayments([]))
    // Un pago con method='saldo_favor' descuenta el saldo del lado del
    // servidor -- refrescarlo acá para que el drawer no siga ofreciendo un
    // monto máximo desactualizado si se abre de nuevo.
    if (order?.contact_id) getStoreCreditBalance(order.contact_id).then(setStoreCreditBalance).catch(() => {})
  }

  function reloadComments() {
    if (!id) return
    listCommentsForOrder(id).then(setComments)
  }

  useEffect(() => {
    if (isNew) return
    setOrder(undefined)
    setItemsLoaded(false)
    reloadOrder()
    reloadItems()
    reloadPayments()
    reloadComments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Carga el estado inicial del borrador SOLO cuando cambia a un pedido
  // distinto (order.id), nunca en cada reload de este mismo pedido -- a
  // diferencia de antes, un reload ahora puede pasar en medio de una
  // edición en curso (lo dispara el propio autosave, ver más abajo), y
  // pisar el borrador local con lo último que devolvió el servidor
  // rompería justo lo que se estaba tipeando si hubo un cambio nuevo
  // durante el viaje de ida y vuelta. */
  useEffect(() => {
    if (isNew || !order) return
    setContactId(order.contact_id)
    setOpportunityId(order.opportunity_id ?? '')
    setStatus(order.status)
    setValidUntil(order.valid_until ?? '')
    setShippingAddressId(order.shipping_address_id ?? '')
    setBillingAddressId(order.billing_address_id ?? '')
    setShippingDraft(String(order.shipping))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id])

  useEffect(() => {
    if (!profile?.tenant_id) return
    listClients(profile.tenant_id).then(setContacts).catch(() => {})
    listOpportunities(profile.tenant_id).then(setOpportunities).catch(() => {})
    listProducts(profile.tenant_id, { page: 1, pageSize: 1000 })
      .then(({ data }) => setProducts(data))
      .catch(() => {})
    listProductCategories(profile.tenant_id).then(setCategories).catch(() => {})
    listBrands(profile.tenant_id).then(setBrands).catch(() => {})
    listWarehouses(profile.tenant_id).then(setWarehouses).catch(() => {})
    listStockByWarehouse(profile.tenant_id).then(setStockRows).catch(() => {})
  }, [profile?.tenant_id])

  useEffect(() => {
    if (!contactId) {
      setAddresses([])
      return
    }
    listAddressesForContact(contactId).then(setAddresses).catch(() => setAddresses([]))
  }, [contactId])

  // Edit mode only -- "Tareas relacionadas" needs a real linked opportunity
  // on a saved order (order is always null while creating, so this simply
  // never populates in new mode, matching the card being hidden there too).
  useEffect(() => {
    if (isNew) return
    if (!order?.opportunity_id) {
      setRelatedTasks([])
      return
    }
    listTasksForOpportunity(order.opportunity_id).then(setRelatedTasks).catch(() => setRelatedTasks([]))
  }, [isNew, order?.opportunity_id])

  // Clears a stale opportunity/address selection while still drafting a new
  // order (in edit mode this is handled atomically server-side instead, see
  // handleContactSelect).
  useEffect(() => {
    if (!isNew) return
    if (opportunityId && !opportunities.some((o) => o.id === opportunityId && o.contact_id === contactId)) setOpportunityId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  useEffect(() => {
    if (!isNew) return
    if (shippingAddressId && !addresses.some((a) => a.id === shippingAddressId)) setShippingAddressId('')
    if (billingAddressId && !addresses.some((a) => a.id === billingAddressId)) setBillingAddressId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses])

  useEffect(() => {
    if (!contactChangedNotice) return
    const timer = setTimeout(() => setContactChangedNotice(false), 5000)
    return () => clearTimeout(timer)
  }, [contactChangedNotice])

  const contactOpportunities = useMemo(() => opportunities.filter((o) => o.contact_id === contactId), [opportunities, contactId])
  // Same table, split by is_internal (ver types/domain.ts) -- newest first
  // in both, like a conversation. Stays null (not []) while comments hasn't
  // loaded yet so each column can still tell "loading" from "empty".
  const notesList = useMemo(() => (comments ? comments.filter((c) => c.is_internal) : null), [comments])
  const commentsList = useMemo(() => (comments ? comments.filter((c) => !c.is_internal) : null), [comments])
  const totalPaid = useMemo(() => (payments ?? []).reduce((sum, p) => sum + p.amount, 0), [payments])
  const totalQuantity = useMemo(() => items.reduce((sum, i) => sum + i.quantity, 0), [items])
  // Solo para el modo "crear", antes de que exista un order_id real que el
  // servidor pueda calcular -- ver comentario grande en el resumen del
  // render. No es un cálculo de impuesto/descuento, es la misma suma que ya
  // se ve línea por línea en OrderItemsEditor.
  const draftSubtotalEstimate = useMemo(() => items.reduce((sum, i) => sum + i.quantity * i.unit_price - (i.discount_amount ?? 0), 0), [items])

  const contactError = isNew && touched && !isNotBlank(contactId) ? t('orders.drawer.errors.contactRequired') : undefined

  // ----- Autosave centralizado: TODO el estado editable del pedido
  // (cliente, oportunidad, válida hasta, direcciones, envío, ítems) vive en
  // el estado local de arriba, y este único efecto es lo único que lo
  // persiste -- 2s después del último cambio, llama a calculate-order
  // (Edge Function) con el borrador completo. Nada de subtotal/impuesto/
  // total se calcula acá: lo que se ve en pantalla siempre sale de `order`,
  // que se refresca con la respuesta real del servidor después de guardar.
  // Pedido explícito del usuario 2026-09-03: un solo proceso centralizado,
  // sin cálculos en el frontend, sin guardado inmediato por campo.
  //
  // primedOrderIdRef + lastSyncedSnapshotRef existen para no disparar un
  // guardado fantasma apenas se termina de cargar el pedido (eso no es una
  // edición del agente, es el estado que ya está en el servidor) -- recién
  // "priming" cuando tanto `order` como los ítems (que llegan por una
  // fetch aparte, ver reloadItems/itemsLoaded) ya cargaron los dos.
  const primedOrderIdRef = useRef<string | null>(null)
  const lastSyncedSnapshotRef = useRef<string>('')

  function currentDraftSnapshot(): string {
    return JSON.stringify({ contactId, opportunityId, validUntil, shippingAddressId, billingAddressId, shippingDraft, items })
  }

  async function saveDraft(orderId: string, snapshot: string) {
    if (hasIncompleteVariantSelection(items, products)) {
      setActionError(t('orders.itemsEditor.variantRequired'))
      return
    }
    setActionError(null)
    setSavingDraft(true)
    try {
      await calculateOrder({
        order_id: orderId,
        contact_id: contactId,
        opportunity_id: opportunityId || null,
        valid_until: validUntil || null,
        shipping_address_id: shippingAddressId || null,
        billing_address_id: billingAddressId || null,
        shipping: Number(shippingDraft) || 0,
        items,
      })
      lastSyncedSnapshotRef.current = snapshot
      reloadOrder()
      reloadItems()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save'))
    } finally {
      setSavingDraft(false)
    }
  }

  useEffect(() => {
    // Ya no es cotización -- venta real, nada de esto se autoguarda más
    // (mismo candado que calculate-order/index.ts aplica del lado del
    // servidor; esto es solo para no ni siquiera intentar el viaje de red
    // si por lo que sea un control quedó habilitado).
    if (isNew || !order || !itemsLoaded || order.status !== 'cotizacion') return
    const snapshot = currentDraftSnapshot()

    if (primedOrderIdRef.current !== order.id) {
      // Recién terminó de cargar este pedido -- es el estado base, no un
      // cambio del agente. Nada que guardar todavía.
      primedOrderIdRef.current = order.id
      lastSyncedSnapshotRef.current = snapshot
      return
    }
    if (snapshot === lastSyncedSnapshotRef.current) return

    const timer = setTimeout(() => {
      void saveDraft(order.id, snapshot)
    }, 2000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, itemsLoaded, contactId, opportunityId, validUntil, shippingAddressId, billingAddressId, shippingDraft, items])

  function handleContactSelect(newContactId: string | null) {
    setEditingContact(false)
    if (!newContactId || newContactId === contactId) return
    setContactId(newContactId)
    // Cambiar de cliente invalida oportunidad/direcciones del cliente
    // anterior -- solo tiene sentido resetearlas en modo edición (al crear
    // todavía no había nada elegido).
    if (!isNew) {
      setOpportunityId('')
      setShippingAddressId('')
      setBillingAddressId('')
      setContactChangedNotice(true)
    }
  }

  function handleOpportunitySelect(newId: string | null) {
    setOpportunityId(newId ?? '')
  }

  async function handleStatusSelect(newStatus: OrderStatus) {
    if (isNew) {
      setStatus(newStatus)
      return
    }
    if (!order || !profile?.tenant_id) return
    setActionError(null)
    // Stock is only checked at the exact moment a cotización turns into a
    // venta -- quoting is allowed to exceed what's on hand, confirming
    // isn't (explicit product decision). Void (-> cancelada) never needs
    // this check.
    if (order.status === 'cotizacion' && newStatus === 'confirmada') {
      try {
        const shortfalls = await findStockShortfalls(profile.tenant_id, items, warehouses)
        if (shortfalls.length > 0) {
          setStockShortfalls(shortfalls)
          setShortfallDialogOpen(true)
          return
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save'))
        return
      }
    }
    setAdvancingStatus(true)
    updateOrderStatus(order.id, newStatus)
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save')))
      .finally(() => setAdvancingStatus(false))
  }

  /** Fully independent from handleStatusSelect -- delivery_status never
   * gates or is gated by the order's commercial status, no stock check,
   * no restriction on which values are reachable from which (ver
   * types/domain.ts). */
  function handleDeliveryStatusSelect(newStatus: DeliveryStatus) {
    if (!order) return
    // Pedido explícito del usuario 2026-09-04: despachar con saldo
    // pendiente no se bloquea (puede ser una decisión real del negocio),
    // pero exige una confirmación explícita en vez de aplicarse directo --
    // ver pendingDeliveryStatus/ConfirmDialog más abajo.
    if (newStatus !== 'pendiente' && balance > 0) {
      setPendingDeliveryStatus(newStatus)
      return
    }
    applyDeliveryStatus(newStatus)
  }

  function applyDeliveryStatus(newStatus: DeliveryStatus) {
    if (!order) return
    setActionError(null)
    updateDeliveryStatus(order.id, newStatus)
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save')))
  }

  function handleValidUntilChange(value: string) {
    setValidUntil(value)
  }

  function handleAddressSelect(kind: 'shipping' | 'billing', addressId: string | null) {
    if (kind === 'shipping') {
      setEditingShippingAddress(false)
      setShippingAddressId(addressId ?? '')
    } else {
      setEditingBillingAddress(false)
      setBillingAddressId(addressId ?? '')
    }
  }

  /** New address created inline (see the "+" next to each address field) --
   * auto-applies it to whichever role(s) it was flagged for if that role is
   * still unset, so creating a shipping address is normally a single action
   * instead of create-then-pick. Solo toca estado local -- el autosave
   * centralizado se encarga de persistirlo. */
  function handleAddressCreated(newAddress: ContactAddress) {
    setAddresses((prev) => [newAddress, ...prev])
    if (newAddress.is_shipping && !shippingAddressId) setShippingAddressId(newAddress.id)
    if (newAddress.is_billing && !billingAddressId) setBillingAddressId(newAddress.id)
  }

  async function handleAddNote(e: FormEvent) {
    e.preventDefault()
    if (!noteDraft.trim() || !profile?.tenant_id || !id) return
    setSavingNote(true)
    try {
      await createComment(profile.tenant_id, id, noteDraft.trim(), true)
      setNoteDraft('')
      setAddingNote(false)
      reloadComments()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('orders.detail.errors.notes'))
    } finally {
      setSavingNote(false)
    }
  }

  async function handleCreate() {
    setTouched(true)
    setActionError(null)
    if (!isNotBlank(contactId) || !profile?.tenant_id) return

    const validItems = items.filter((item) => isNotBlank(item.product_name))
    if (hasIncompleteVariantSelection(validItems, products)) {
      setActionError(t('orders.itemsEditor.variantRequired'))
      return
    }

    // Same rule as handleStatusSelect: creating directly as a venta (not a
    // cotización) skips the separate "convert" step but not this check.
    if (status !== 'cotizacion') {
      try {
        const shortfalls = await findStockShortfalls(profile.tenant_id, validItems, warehouses)
        if (shortfalls.length > 0) {
          setStockShortfalls(shortfalls)
          setShortfallDialogOpen(true)
          return
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('orders.detail.errors.create'))
        return
      }
    }

    setCreating(true)
    try {
      // calculate-order siempre crea en 'cotizacion' (ver comentario de
      // cabecera en el Edge Function) -- si el agente eligió "Confirmada"
      // en este formulario, el paso a confirmada es una segunda llamada,
      // ahora que los ítems ya existen de verdad y el trigger de
      // confirmación tiene algo real contra qué validar stock.
      const created = await calculateOrder({
        contact_id: contactId,
        opportunity_id: opportunityId || null,
        valid_until: validUntil || null,
        shipping_address_id: shippingAddressId || null,
        billing_address_id: billingAddressId || null,
        shipping: Number(shippingDraft) || 0,
        items: validItems,
      })
      if (status === 'confirmada') await updateOrderStatus(created.id, 'confirmada')
      navigate(`/app/sales/${created.id}`, { replace: true })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('orders.detail.errors.create'))
    } finally {
      setCreating(false)
    }
  }

  async function handleAddComment(e: FormEvent) {
    e.preventDefault()
    if (!commentDraft.trim() || !profile?.tenant_id || !id) return
    setSavingComment(true)
    try {
      await createComment(profile.tenant_id, id, commentDraft.trim())
      setCommentDraft('')
      setAddingComment(false)
      reloadComments()
    } catch {
      /* keep the draft on failure so the agent doesn't lose what they typed */
    } finally {
      setSavingComment(false)
    }
  }

  async function handleDeletePayment() {
    if (!deletePaymentId) return
    try {
      await deletePayment(deletePaymentId)
      setDeletePaymentId(null)
      reloadPayments()
    } catch {
      setDeletePaymentId(null)
    }
  }

  async function handleVoid() {
    if (!order) return
    setVoiding(true)
    try {
      await updateOrderStatus(order.id, 'cancelada')
      setConfirmingVoid(false)
      reloadOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('orders.detail.errors.void'))
      setConfirmingVoid(false)
    } finally {
      setVoiding(false)
    }
  }

  async function handleDelete() {
    if (!order) return
    setDeleting(true)
    try {
      await deleteOrder(order.id)
      navigate('/app/sales')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('orders.detail.errors.delete'))
      setDeleting(false)
    }
  }

  if (!isNew) {
    if (loadError) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
    if (order === undefined) return <PageSpinner />
    if (order === null) {
      return (
        <div className="space-y-4">
          <p className="text-brand-500">{t('orders.detail.notFound')}</p>
          <Link to="/app/sales" className="text-sm font-medium text-accent-600 hover:text-accent-700">
            {t('orders.detail.backToList')}
          </Link>
        </div>
      )
    }
  }

  const balance = order ? Math.max(0, order.total - totalPaid) : 0
  const selectedContact = contacts.find((c) => c.id === contactId)
  // Reglas explícitas del usuario 2026-09-04 -- ya no es "apenas se
  // confirma": una venta confirmada que TODAVÍA no salió (sin despachar) y
  // cuya factura TODAVÍA no se envió/aceptó por la DIAN sigue siendo
  // corregible (typo en el precio antes de que el cliente reciba el
  // pedido). Se bloquea recién cuando pasa alguna de estas dos cosas
  // reales e irreversibles -- y en esos dos casos también se bloquea
  // Anular, no solo la composición del pedido:
  // - la factura electrónica ya fue enviada/aceptada por la DIAN (un
  //   documento fiscal ya transmitido no se puede pisar por debajo; si la
  //   DIAN la RECHAZÓ sigue editable a propósito, para poder corregir y
  //   reintentar);
  // - el pedido ya tiene algún movimiento de despacho (delivery_status
  //   distinto de 'pendiente', ya sea vía el select simple o el módulo de
  //   Despachos, que mantiene este mismo campo sincronizado).
  // Un pedido anulado también queda bloqueado, pero eso ya es automático:
  // el botón "Anular" solo existe mientras status === 'confirmada' (ver
  // más abajo), así que una vez anulado no hay ninguna acción de
  // composición que mostrar de todos modos.
  const dianLocksOrder = !!latestInvoice && (latestInvoice.status === 'sent' || latestInvoice.status === 'accepted')
  // Hallazgo real al probar: con el módulo de Despachos habilitado,
  // sales_orders.delivery_status NUNCA se sincroniza (confirmado leyendo
  // log_dispatch_status_change() -- solo escribe dispatch_status_history,
  // no toca delivery_status) -- la única señal real ahí es que exista una
  // fila en `dispatches` para este pedido, sin importar en qué estado
  // (dispatchStatus !== null, ver reloadDispatchStatus). Sin el módulo, la
  // única vía es el select simple, que sí escribe delivery_status
  // directo. Hay que chequear las dos.
  const dispatchLocksOrder = !!order && (dispatchStatus !== null || order.delivery_status !== 'pendiente')
  const locked = !isNew && !!order && (dianLocksOrder || dispatchLocksOrder || order.status === 'cancelada')

  const addressField = (kind: 'shipping' | 'billing') => {
    const value = kind === 'shipping' ? shippingAddressId : billingAddressId
    const filtered = addresses.filter((a) => (kind === 'shipping' ? a.is_shipping : a.is_billing))
    const selected = filtered.find((a) => a.id === value)
    const editing = kind === 'shipping' ? editingShippingAddress : editingBillingAddress
    const setEditing = kind === 'shipping' ? setEditingShippingAddress : setEditingBillingAddress
    return (
      <div>
        <Label>{t(kind === 'shipping' ? 'orders.detail.shipping' : 'orders.detail.billing')}</Label>
        {selected && !editing ? (
          <div className="mt-1 flex items-start justify-between gap-2">
            <div className="min-w-0 text-sm">
              <p className="truncate text-brand-800">
                {selected.line1}
                {selected.line2 ? `, ${selected.line2}` : ''}
              </p>
              {(selected.city || selected.state_province || selected.country) && (
                <p className="truncate text-xs text-brand-400">{[selected.city, selected.state_province, selected.country].filter(Boolean).join(', ')}</p>
              )}
            </div>
            {!locked && (
              <Button type="button" variant="default" size="icon-sm" onClick={() => setEditing(true)} aria-label={t('orders.detail.changeAddressAria')} className="shrink-0">
                <PencilIcon width={12} height={12} />
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-1 flex gap-2">
            <ComboboxFilter
              options={filtered.map((a) => ({ id: a.id, label: addressLabel(a) }))}
              value={value || null}
              onChange={(v) => handleAddressSelect(kind, v)}
              placeholder={t('orders.detail.noAddress')}
              searchPlaceholder={t('orders.detail.searchAddress')}
              emptyLabel={t('orders.detail.noAddressResults')}
              disabled={locked}
              className="min-w-0 flex-1"
              triggerClassName="min-w-0 flex-1 shrink"
            />
            <Button
              type="button"
              variant="default"
              size="icon"
              onClick={() => setAddressDrawerOpen(true)}
              disabled={!contactId || locked}
              aria-label={t('orders.detail.newAddressAria')}
              className="shrink-0"
            >
              <PlusIcon width={14} height={14} />
            </Button>
          </div>
        )}
      </div>
    )
  }

  // Sin botón de "Guardar" -- el autosave (ver useEffect de arriba)
  // persiste solo, 2s después del último cambio. Este indicador es
  // puramente informativo.
  const itemsSaveAction = !isNew && savingDraft ? <span className="text-xs font-medium text-brand-400">{t('common.actions.saving')}</span> : undefined

  const showPayments = (isNew ? status : order?.status) !== 'cotizacion'
  const showTasks = !isNew && !!relatedTasks && relatedTasks.length > 0
  const showInvoiceCard = !isNew && !!latestInvoice
  const hasSidePanel = showPayments || showTasks || showInvoiceCard

  const isInvoiceAdmin = profile?.role === 'tenant_admin' || profile?.role === 'superadmin'
  // Pedido explícito del usuario 2026-09-04: no se manda un documento fiscal
  // real a la DIAN de una venta que todavía no está cobrada del todo -- el
  // candado real está en dian-submit/index.ts (rechaza aunque alguien llame
  // la función directo), esto es solo la parte de UX.
  const isFullyPaid = balance === 0
  const canSendInvoice = latestInvoice?.status === 'pending' && isInvoiceAdmin && isFullyPaid
  // Reintentar sólo tiene sentido sobre un intento que ya fracasó: el índice
  // único parcial de sales_invoices no admite un segundo intento vivo
  // mientras el anterior no esté en 'rejected'/'error'.
  const canRetryInvoice = (latestInvoice?.status === 'rejected' || latestInvoice?.status === 'error') && isInvoiceAdmin && isFullyPaid
  // Para explicarle al agente POR QUÉ no ve el botón cuando la factura ya
  // está en un estado que normalmente lo mostraría -- distinto de "no sos
  // admin" (eso no se explica, es autoevidente por el rol).
  const invoiceBlockedByBalance = !isFullyPaid && isInvoiceAdmin && (latestInvoice?.status === 'pending' || latestInvoice?.status === 'rejected' || latestInvoice?.status === 'error')
  // Una sola fila: el estado actual de la factura ante la DIAN y la acción
  // que corresponda (enviarla, o reintentar si falló). Sin listado de
  // intentos y sin botón de descarga -- la descarga vive una sola vez, en el
  // encabezado del pedido (feedback explícito del usuario 2026-09-03).
  const invoiceCard = latestInvoice && (
    <StatCard title={t('einvoicing.cardTitle')}>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className={`border-transparent ${INVOICE_STATUS_VARIANT[latestInvoice.status]}`}>
          {t(`einvoicing.status.${latestInvoice.status}`)}
        </Badge>
        <div className="flex shrink-0 items-center gap-1.5">
          {canSendInvoice && (
            <Button type="button" size="sm" onClick={() => handleSendInvoice()} disabled={sendingInvoice}>
              {sendingInvoice ? t('einvoicing.detail.sending') : t('einvoicing.detail.send')}
            </Button>
          )}
          {canRetryInvoice && (
            <Button type="button" size="sm" onClick={() => handleSendInvoice(true)} disabled={sendingInvoice}>
              <RefreshCwIcon className="size-3.5" />
              {sendingInvoice ? t('einvoicing.detail.retrying') : t('einvoicing.detail.retry')}
            </Button>
          )}
        </div>
      </div>
      {/* El motivo del rechazo es justamente lo que hace falta para poder
          corregir y reintentar -- es el único dato del fracaso que se
          conserva a la vista. */}
      {latestInvoice.status_detail && <p className="mt-1.5 text-xs text-amber-700">{latestInvoice.status_detail}</p>}
      {invoiceBlockedByBalance && <p className="mt-1.5 text-xs text-amber-700">{t('einvoicing.detail.balancePending', { amount: formatCurrency(balance, order?.currency) })}</p>}
      {/* El CUFE es un hash que calculamos nosotros mismos antes de enviar
          -- existe aunque la DIAN haya rechazado el documento (ver
          sendInvoiceToDian.ts). Mostrarlo igual acá es engañoso: no
          significa nada hasta que la DIAN lo acepte de verdad. Mismo
          criterio ya aplicado al QR del PDF (buildInvoicePdf.ts) --
          feedback explícito del usuario 2026-09-03. */}
      {(latestInvoice.status === 'sent' || latestInvoice.status === 'accepted') && latestInvoice.cufe && (
        <p className="mt-1.5 break-all text-[11px] text-brand-400">
          {t('einvoicing.detail.cufe')}: {latestInvoice.cufe}
        </p>
      )}
      {sendInvoiceError && <FieldError message={sendInvoiceError} />}
    </StatCard>
  )

  const paymentsCard =
    !isNew && order ? (
      <StatCard
        title={t('orders.detail.payments')}
        action={
          <Button type="button" variant="default" size="icon-sm" onClick={() => setPaymentDrawerOpen(true)} aria-label={t('orders.detail.registerPaymentAria')}>
            <PlusIcon width={13} height={13} />
          </Button>
        }
      >
        {balance > 0 ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700">
            {t('orders.detail.pendingBalance', { amount: formatCurrency(balance, order.currency) })}
          </div>
        ) : (
          payments &&
          payments.length > 0 && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700">{t('orders.detail.fullyPaid')}</div>
          )
        )}

        {payments && payments.length > 0 && (
          <ul className="mt-2 space-y-1">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-xs text-brand-600">
                <span className="min-w-0 truncate">
                  {p.method === 'wompi' && p.provider_reference ? `${t(PAYMENT_METHOD_LABEL_KEY.wompi)} · ${p.provider_reference}` : t(PAYMENT_METHOD_LABEL_KEY[p.method])} · {formatDate(p.paid_at)}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="font-medium text-brand-800">{formatCurrency(p.amount, p.currency)}</span>
                  {order.status === 'cotizacion' ? (
                    <button type="button" onClick={() => setDeletePaymentId(p.id)} className="text-brand-300 hover:text-red-600" aria-label={t('orders.detail.deletePaymentAria')}>
                      <TrashIcon width={11} height={11} />
                    </button>
                  ) : (
                    <span title={t('orders.detail.paymentLocked')} className="text-brand-200">
                      <TrashIcon width={11} height={11} />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {payments && payments.length === 0 && balance === 0 && <p className="text-xs text-brand-400">{t('orders.detail.noPayments')}</p>}
      </StatCard>
    ) : (
      <StatCard title={t('orders.detail.payments')}>
        <p className="text-xs text-brand-400">{t('orders.detail.paymentsAfterCreateHint')}</p>
      </StatCard>
    )

  const detailsContent = (
    <div className="space-y-4">
      {/* Row 1: 1. Cliente y direcciones + Pagos/Tareas al lado -- pedido
          explícito del usuario de que los pagos queden junto a la card de
          cliente en vez de más abajo en la página. */}
      <div className={`grid grid-cols-1 gap-4 ${hasSidePanel ? 'lg:grid-cols-3' : ''}`}>
        <StatCard title={t('orders.detail.sections.clientAndAddresses')} className={hasSidePanel ? 'lg:col-span-2' : ''}>
          <div className="grid grid-cols-1 gap-y-4 sm:grid-cols-3 sm:gap-x-6">
            {/* Columna 1: Cliente + Facturación */}
            <div className="space-y-4">
              <div>
                <Label>{t('orders.drawer.fields.contact')}</Label>
                {contactId && !editingContact && selectedContact ? (
                  <div className="mt-1 flex items-start justify-between gap-2">
                    <div className="min-w-0 text-sm">
                      <p className="truncate text-brand-800">{selectedContact.full_name}</p>
                      <p className="truncate text-xs text-brand-400">{[selectedContact.nit ? `NIT ${selectedContact.nit}` : null, formatClientPhoneDisplay(selectedContact.phone_prefix, selectedContact.phone)].filter(Boolean).join(' · ')}</p>
                    </div>
                    {!locked && (
                      <Button type="button" variant="default" size="icon-sm" onClick={() => setEditingContact(true)} aria-label={t('orders.detail.changeContactAria')} className="shrink-0">
                        <PencilIcon width={12} height={12} />
                      </Button>
                    )}
                  </div>
                ) : (
                  <ComboboxFilter
                    options={contacts.map((c) => ({ id: c.id, label: c.full_name }))}
                    value={null}
                    onChange={handleContactSelect}
                    placeholder={t('orders.drawer.fields.selectPlaceholder')}
                    searchPlaceholder={t('orders.detail.searchContact')}
                    emptyLabel={t('orders.detail.noContactResults')}
                    disabled={locked}
                    className="mt-1 w-full"
                    triggerClassName="min-w-0 flex-1 shrink"
                  />
                )}
                <FieldError message={contactError} />
              </div>
              {addressField('billing')}
            </div>

            {/* Columna 2: Envío + Estado de envío */}
            <div className="space-y-4 sm:border-l sm:border-brand-100 sm:pl-4">
              {addressField('shipping')}
              {/* Estado de envío -- solo edición + venta confirmada (concepto
                  aparte del estado comercial, ver DeliveryStatus). No aplica
                  en cotización/cancelada, no hay nada que enviar todavía o
                  ya no corre. */}
              {!isNew && order && order.status === 'confirmada' && (
                <div>
                  <div className="flex items-center justify-between">
                    <Label>{t('orders.drawer.fields.deliveryStatus')}</Label>
                    {/* Con el módulo de Despachos habilitado, el estado real
                        vive en dispatch_statuses (configurable, con
                        timeline/transportadora/guía) y sincroniza este campo
                        automáticamente -- ya no se edita a mano acá, este
                        link es el único punto de entrada a esa vista. */}
                    {enabledModules?.has('dispatches') && (
                      <button type="button" onClick={() => setDispatchDrawerOpen(true)} className="text-[11px] font-medium text-accent-600 hover:text-accent-700">
                        {t('dispatches.detail.link')}
                      </button>
                    )}
                  </div>
                  {enabledModules?.has('dispatches') ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs">
                      {/* Mismo tamaño que la línea secundaria de
                          ciudad/estado en las direcciones (text-xs, sin
                          negrita) -- "Entregado" no debe competir en
                          jerarquía con el nombre/dirección de arriba. Solo el
                          punto lleva el color real del estado; el texto queda
                          en el mismo gris que esa línea secundaria (pedido
                          explícito del usuario: nombre en negro, color solo
                          en el punto). */}
                      {dispatchStatus && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dispatchStatus.color }} />}
                      <span className="truncate text-brand-400">{dispatchStatus?.name ?? t(DELIVERY_STATUS_LABEL_KEY[order.delivery_status])}</span>
                    </p>
                  ) : (
                    <Select value={order.delivery_status} onValueChange={(v) => handleDeliveryStatusSelect(v as DeliveryStatus)}>
                      <SelectTrigger className="mt-1 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(DELIVERY_STATUS_LABEL_KEY) as DeliveryStatus[]).map((s) => (
                          <SelectItem key={s} value={s}>
                            {t(DELIVERY_STATUS_LABEL_KEY[s])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>

            {/* Columna 3: Oportunidad + Estado (solo al crear) + Válida
                hasta (solo cotización -- no aplica a una venta ya
                confirmada, se oculta entera en vez de mostrarla deshabilitada). */}
            <div className="space-y-4 sm:border-l sm:border-brand-100 sm:pl-4">
              <div>
                <Label>{t('orders.drawer.fields.opportunity')}</Label>
                <ComboboxFilter
                  options={contactOpportunities.map((o) => ({ id: o.id, label: o.title }))}
                  value={opportunityId || null}
                  onChange={handleOpportunitySelect}
                  placeholder={t('orders.drawer.fields.noOpportunity')}
                  searchPlaceholder={t('orders.detail.searchOpportunity')}
                  emptyLabel={t('orders.detail.noOpportunityResults')}
                  disabled={locked}
                  className="mt-1 w-full"
                  triggerClassName="min-w-0 flex-1 shrink"
                />
              </div>
              {isNew && (
                <div>
                  <Label>{t('orders.drawer.fields.status')}</Label>
                  <Select value={status} onValueChange={(v) => handleStatusSelect(v as OrderStatus)}>
                    <SelectTrigger className="mt-1 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CREATE_STATUS_OPTIONS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(ORDER_STATUS_LABEL_KEY[s])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(isNew ? status : order?.status) === 'cotizacion' && (
                <div>
                  <Label>{t('orders.drawer.fields.validUntil')}</Label>
                  <Input type="date" value={validUntil} onChange={(e) => handleValidUntilChange(e.target.value)} className="mt-1" />
                </div>
              )}
            </div>
          </div>

          {contactChangedNotice && <p className="mt-3 text-xs text-amber-600">{t('orders.detail.contactChangedNotice')}</p>}
          {contactId && addresses.length === 0 && <p className="mt-3 text-xs text-brand-400">{t('orders.drawer.noAddressesHint')}</p>}
        </StatCard>

        {hasSidePanel && (
          <div className="space-y-4">
            {showPayments && paymentsCard}
            {showInvoiceCard && invoiceCard}
            {showTasks && (
              <StatCard title={t('orders.detail.relatedTasks')}>
                <ul className="space-y-1.5">
                  {relatedTasks!.map((task) => (
                    <li key={task.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-brand-600">{task.title}</span>
                      <Badge className={task.status === 'completada' ? 'border-transparent bg-emerald-100 text-emerald-700' : 'border-transparent bg-amber-100 text-amber-700'}>
                        {task.status === 'completada' ? t('orders.detail.taskDone') : t('orders.detail.taskPending')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </StatCard>
            )}
          </div>
        )}
      </div>

      {/* 2. Ítems de la orden */}
      <StatCard
        title={t('orders.detail.sections.items')}
        action={
          <div className="flex flex-wrap items-center gap-2.5">
            <Button type="button" variant="outline" size="sm" disabled title={t('orders.detail.comingSoon')}>
              <ScanLineIcon className="size-3.5" /> {t('orders.detail.actions.scan')}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled title={t('orders.detail.comingSoon')}>
              <UploadIcon className="size-3.5" /> {t('orders.detail.actions.import')}
            </Button>
            {itemsSaveAction && <span className="ml-1 border-l border-brand-200 pl-2.5">{itemsSaveAction}</span>}
          </div>
        }
      >
        <OrderItemsEditor
          items={items}
          products={products}
          categories={categories}
          brands={brands}
          warehouses={warehouses}
          stockRows={stockRows}
          shortfalls={stockShortfalls}
          currency={order?.currency ?? 'COP'}
          locked={locked}
          onChange={(next) => {
            setItems(next)
            // Stale otherwise -- a shortfall found for the old quantities/
            // warehouse doesn't necessarily still apply once the agent
            // changes something.
            setStockShortfalls([])
          }}
        />
        {items.length > 0 && (
          <p className="mt-2 text-xs text-brand-400">
            {t(items.length === 1 ? 'orders.detail.itemsSummary.singular' : 'orders.detail.itemsSummary.plural', { count: items.length, qty: totalQuantity })}
          </p>
        )}
      </StatCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 3. Resumen de la orden -- 2026-09-03: nada de esto se calcula acá.
            Subtotal/Descuentos/Impuesto/Total salen siempre de `order`, la
            respuesta real de calculate-order (Edge Function) -- el
            autosave (ver useEffect de arriba) la refresca sola 2s después
            del último cambio. La única excepción es el modo "crear": como
            todavía no existe un pedido real que el servidor pueda
            calcular, se muestra una suma simple de las líneas (ya visible
            por línea en OrderItemsEditor) solo como referencia hasta que
            se guarde -- no es el total final, ni calcula impuesto. */}
        <StatCard title={t('orders.detail.orderSummary')} action={itemsSaveAction}>
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-brand-500">
              <span>{t('orders.detail.subtotal')}</span>
              <span className="font-medium text-brand-700">{formatCurrency(order?.subtotal ?? draftSubtotalEstimate, order?.currency ?? 'COP')}</span>
            </div>
            {!!order?.discount_total && order.discount_total > 0 && (
              <div className="flex items-center justify-between text-brand-500">
                <span>{t('orders.detail.discounts')}</span>
                <span className="font-medium text-emerald-600">-{formatCurrency(order.discount_total, order.currency)}</span>
              </div>
            )}
            {!!order?.tax_total && order.tax_total > 0 && (
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-brand-500">{t('orders.drawer.fields.tax')}</span>
                <span className="font-medium text-brand-700">{formatCurrencyPrecise(order.tax_total, order.currency)}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <Label className="shrink-0 text-xs text-brand-500">{t('orders.drawer.fields.shipping')}</Label>
              <CurrencyInput value={shippingDraft} onChange={(e) => setShippingDraft(e.target.value)} disabled={locked} className="h-7 w-28 text-right text-xs" />
            </div>
            <div className="flex items-center justify-between border-t border-brand-100 pt-1.5">
              <span className="text-sm font-bold text-brand-800">{t('orders.detail.total')}</span>
              <span className="text-base font-bold text-emerald-600">{formatCurrency(order?.total ?? draftSubtotalEstimate, order?.currency ?? 'COP')}</span>
            </div>
          </div>
        </StatCard>

        {/* 4. Notas y comentarios -- una sola card, dividida en 2 columnas
            (mismo criterio que Envío/Facturación: línea vertical al centro,
            no tabs). Cada columna es su propio hilo tipo conversación
            (contenido + autor + fecha) en vez de Notas siendo un textarea
            único -- ambas viven en sales_order_comments, diferenciadas por
            is_internal. Solo en edición: necesitan un order.id real. */}
        {!isNew && (
          <StatCard title={t('orders.detail.sections.notesAndComments')}>
            <div className="grid grid-cols-1 gap-y-5 sm:grid-cols-2 sm:gap-x-6">
              <ThreadColumn
                label={t('orders.detail.notesTab')}
                entries={notesList}
                adding={addingNote}
                onToggleAdd={() => setAddingNote((v) => !v)}
                addAria={t('orders.detail.addNoteAria')}
                form={
                  <form onSubmit={handleAddNote} className="rounded-lg border border-brand-100 bg-brand-50/40 p-2 focus-within:border-accent-300">
                    <Textarea
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder={t('orders.detail.notesPlaceholder')}
                      rows={2}
                      autoFocus
                      className="resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                    />
                    <div className="mt-1 flex justify-end">
                      <Button type="submit" size="sm" disabled={savingNote || !noteDraft.trim()}>
                        {savingNote ? t('common.actions.saving') : t('common.actions.save')}
                      </Button>
                    </div>
                  </form>
                }
              />

              <div className="sm:border-l sm:border-brand-100 sm:pl-6">
                <ThreadColumn
                  label={t('orders.detail.commentsTab')}
                  entries={commentsList}
                  adding={addingComment}
                  onToggleAdd={() => setAddingComment((v) => !v)}
                  addAria={t('orders.detail.addCommentAria')}
                  form={
                    <form onSubmit={handleAddComment} className="rounded-lg border border-brand-100 bg-brand-50/40 p-2 focus-within:border-accent-300">
                      <Textarea
                        value={commentDraft}
                        onChange={(e) => setCommentDraft(e.target.value)}
                        placeholder={t('orders.detail.commentPlaceholder')}
                        rows={2}
                        autoFocus
                        className="resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                      />
                      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                        <Button type="submit" size="sm" disabled={savingComment || !commentDraft.trim()}>
                          {savingComment ? t('common.actions.saving') : t('common.actions.save')}
                        </Button>
                      </div>
                    </form>
                  }
                />
              </div>
            </div>
          </StatCard>
        )}
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {isNew ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-brand-800">{t(status === 'cotizacion' ? 'orders.drawer.newTitle' : 'orders.detail.newSaleTitle')}</h1>
            <p className="mt-1 text-sm text-brand-500">{t('orders.detail.newSubtitle')}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate('/app/sales')}>
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? t('common.actions.saving') : t('orders.detail.createAction')}
            </Button>
          </div>
        </div>
      ) : (
        order && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-brand-800">ORD-{order.number}</h1>
              <Badge className={ORDER_STATUS_BADGE_CLASS[order.status]}>{t(ORDER_STATUS_LABEL_KEY[order.status])}</Badge>
              <p className="flex items-center gap-1 text-sm font-medium text-brand-600">
                <ClockIcon width={13} height={13} /> {t('orders.detail.createdAtLabel')}: {formatDateTime(order.created_at, language)}
              </p>
              {order.created_by_profile && <span className="text-xs text-brand-400">· {order.created_by_profile.full_name}</span>}
            </div>
            {/* Botones condicionados al estado actual -- reemplaza el menú
                "···" y el Select de Estado de más abajo (pedido explícito
                del usuario: nada de un selector que deje saltar a cualquier
                estado, solo las transiciones que de verdad aplican desde
                acá). Solo cubre el estado *comercial* (cotización/venta/
                anulada) -- el de envío se edita aparte, ver la card 1. */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Siempre disponible, haya o no facturación DIAN: un tenant
                  sin configuración DIAN igual necesita imprimir el documento
                  -- en ese caso el servidor emite una REMISIÓN (mismo
                  diseño, numerada REM-<pedido>) en vez de una factura
                  (pedido explícito del usuario 2026-09-04). */}
              <Button type="button" variant="outline" size="sm" onClick={handleDownloadInvoicePdf} disabled={downloadingInvoiceId !== null}>
                <DownloadIcon className="size-3.5" /> {downloadingInvoiceId ? t('einvoicing.detail.downloading') : t('einvoicing.detail.downloadPdf')}
              </Button>
              {order.status === 'cotizacion' && (
                <>
                  <Button size="sm" onClick={() => handleStatusSelect('confirmada')} disabled={advancingStatus}>
                    {advancingStatus ? t('common.actions.saving') : t('orders.detail.actions.confirmSale')}
                  </Button>
                  <Button variant="outline" size="sm" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingDelete(true)}>
                    {t('orders.detail.deleteAction')}
                  </Button>
                </>
              )}
              {order.status === 'confirmada' && !locked && (
                <Button variant="outline" size="sm" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingVoid(true)}>
                  {t('orders.detail.voidAction')}
                </Button>
              )}
            </div>
          </div>
        )
      )}

      {/* El PDF se puede descargar aunque no exista factura DIAN (remisión),
          así que su error NO puede vivir dentro de la card de Factura DIAN:
          ahí quedaría invisible justo para los tenants sin DIAN. */}
      {invoicePdfError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{invoicePdfError}</p>}
      {actionError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}

      {detailsContent}

      {profile?.tenant_id && contactId && (
        <AddressDrawer open={addressDrawerOpen} onClose={() => setAddressDrawerOpen(false)} tenantId={profile.tenant_id} contactId={contactId} onSaved={handleAddressCreated} />
      )}

      {!isNew && order && profile?.tenant_id && (
        <PaymentDrawer
          open={paymentDrawerOpen}
          onClose={() => setPaymentDrawerOpen(false)}
          tenantId={profile.tenant_id}
          orderId={order.id}
          creditEnabled={contacts.find((c) => c.id === order.contact_id)?.credit_enabled ?? false}
          storeCreditBalance={storeCreditBalance}
          pendingAmount={balance}
          onSaved={reloadPayments}
        />
      )}

      {!isNew && order && profile?.tenant_id && enabledModules?.has('dispatches') && (
        <DispatchDrawer
          open={dispatchDrawerOpen}
          onClose={() => setDispatchDrawerOpen(false)}
          tenantId={profile.tenant_id}
          order={order}
          balance={balance}
          onOrderChanged={() => {
            reloadOrder()
            reloadDispatchStatus()
          }}
        />
      )}

      <ConfirmDialog
        open={!!deletePaymentId}
        onClose={() => setDeletePaymentId(null)}
        onConfirm={handleDeletePayment}
        title={t('orders.detail.deletePaymentTitle')}
        description={t('orders.detail.deletePaymentBody')}
      />

      <ConfirmDialog
        open={confirmingVoid}
        onClose={() => setConfirmingVoid(false)}
        onConfirm={handleVoid}
        loading={voiding}
        title={t('orders.detail.voidTitle')}
        description={t('orders.detail.voidBody')}
        confirmLabel={t('orders.detail.voidAction')}
      />

      <ConfirmDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
        loading={deleting}
        title={t('orders.detail.deleteTitle')}
        description={t('orders.detail.deleteBody')}
        confirmLabel={t('orders.detail.deleteAction')}
      />

      <ConfirmDialog
        open={!!pendingDeliveryStatus}
        onClose={() => setPendingDeliveryStatus(null)}
        onConfirm={() => {
          if (pendingDeliveryStatus) applyDeliveryStatus(pendingDeliveryStatus)
          setPendingDeliveryStatus(null)
        }}
        title={t('orders.detail.dispatchWithBalanceTitle')}
        description={t('orders.detail.dispatchWithBalanceBody', { amount: formatCurrency(balance, order?.currency) })}
        confirmLabel={t('orders.detail.dispatchWithBalanceConfirm')}
      />

      <StockShortfallDialog shortfalls={stockShortfalls} open={shortfallDialogOpen} onClose={() => setShortfallDialogOpen(false)} />
    </div>
  )
}
