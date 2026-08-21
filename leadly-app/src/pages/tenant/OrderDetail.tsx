import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ScanLineIcon, UploadIcon, XIcon } from 'lucide-react'
import {
  createOrder,
  deleteOrder,
  findStockShortfalls,
  getOrder,
  hasIncompleteVariantSelection,
  listOrderItems,
  updateOrderFields,
  updateOrderItemsAndTotals,
  updateOrderStatus,
  updateDeliveryStatus,
  computeOrderTotals,
  ORDER_STATUS_LABEL_KEY,
  ORDER_STATUS_BADGE_CLASS,
  DELIVERY_STATUS_LABEL_KEY,
} from '../../lib/api/orders'
import type { OrderDetail as OrderDetailType, OrderInput, OrderItemInput, StockShortfall } from '../../lib/api/orders'
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
import { listCommentsForOrder, createComment } from '../../lib/api/orderComments'
import type { OrderCommentWithAuthor } from '../../lib/api/orderComments'
import { listAttachmentsForOrderComments, uploadOrderCommentAttachment } from '../../lib/api/attachments'
import { listTasksForOpportunity } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import type { ContactAddress, SalesOrderPayment, Attachment, OrderStatus, DeliveryStatus, ProductCategory, Brand, Warehouse } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { isNotBlank } from '../../lib/validation'
import { formatDate, formatDateTime } from '../../lib/dates'
import { FieldError, InitialsAvatar, PageSpinner } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput, ImageAttachmentPicker, SignedImage } from '@/components/molecules'
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
import { StockShortfallDialog } from './orders/StockShortfallDialog'
import { AddressDrawer } from './clients/AddressDrawer'

function addressLabel(a: ContactAddress): string {
  return `${a.label ? `${a.label} — ` : ''}${a.line1}${a.city ? `, ${a.city}` : ''}`
}

function itemsEqual(a: OrderItemInput[], b: OrderItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Only relevant at creation -- 'cancelada' isn't offered (a brand new
 * order can't start already voided), and once it exists, edit mode moves
 * status forward through the header buttons instead of a select (see
 * statusActions below). */
const CREATE_STATUS_OPTIONS: OrderStatus[] = ['cotizacion', 'confirmada']

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
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
 * duplicating the list markup. Only what varies (the add-form: Comentarios
 * has an image picker, Notas doesn't) is passed in as `form`. */
function ThreadColumn({
  label,
  entries,
  adding,
  onToggleAdd,
  addAria,
  form,
  attachmentsByComment,
}: {
  label: string
  entries: OrderCommentWithAuthor[] | null
  adding: boolean
  onToggleAdd: () => void
  addAria: string
  form: ReactNode
  attachmentsByComment?: Record<string, Attachment[]>
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
                {attachmentsByComment?.[c.id]?.map((a) => <SignedImage key={a.id} storagePath={a.storage_path} className="mt-1 h-12 w-12" />)}
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
  const { profile } = useAuth()
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

  // ----- items + shipping + tax: the one block with an explicit batch save -----
  const [items, setItems] = useState<OrderItemInput[]>([])
  const [savedItems, setSavedItems] = useState<OrderItemInput[] | null>(null)
  const [shippingDraft, setShippingDraft] = useState('0')
  const [savedShipping, setSavedShipping] = useState<string | null>(null)
  const [taxDraft, setTaxDraft] = useState('0')
  const [savedTaxTotal, setSavedTaxTotal] = useState<string | null>(null)
  const [savingItems, setSavingItems] = useState(false)

  // ----- creation -----
  const [creating, setCreating] = useState(false)

  // ----- payments / notes+comments (edit mode only) -----
  const [payments, setPayments] = useState<SalesOrderPayment[] | null>(null)
  // Both threads live in the same table now (sales_order_comments.is_internal
  // splits them, ver types/domain.ts) -- one fetch, filtered client-side into
  // the two columns (see notesList/commentsList below).
  const [comments, setComments] = useState<OrderCommentWithAuthor[] | null>(null)
  const [attachmentsByComment, setAttachmentsByComment] = useState<Record<string, Attachment[]>>({})
  // Each column's "+" reveals its own form instead of always showing one --
  // explicit user feedback, matches the reference screenshot's collapsed
  // "Comentarios [+]" / "Observaciones [+]" boxes.
  const [addingNote, setAddingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [addingComment, setAddingComment] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentAttachment, setCommentAttachment] = useState<File | null>(null)
  const [savingComment, setSavingComment] = useState(false)
  const [paymentDrawerOpen, setPaymentDrawerOpen] = useState(false)
  const [addressDrawerOpen, setAddressDrawerOpen] = useState(false)
  const [deletePaymentId, setDeletePaymentId] = useState<string | null>(null)
  const [confirmingVoid, setConfirmingVoid] = useState(false)
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
      setSavedItems(mapped)
    })
  }

  function reloadPayments() {
    if (!id) return
    listPaymentsForOrder(id).then(setPayments).catch(() => setPayments([]))
  }

  function reloadComments() {
    if (!id) return
    listCommentsForOrder(id).then((data) => {
      setComments(data)
      const ids = data.map((c) => c.id).filter((cid) => !(cid in attachmentsByComment))
      if (ids.length === 0) return
      listAttachmentsForOrderComments(ids)
        .then((attachments) => {
          setAttachmentsByComment((prev) => {
            const next = { ...prev }
            for (const a of attachments) {
              if (!a.sales_order_comment_id) continue
              next[a.sales_order_comment_id] = [...(next[a.sales_order_comment_id] ?? []), a]
            }
            return next
          })
        })
        .catch(() => {})
    })
  }

  useEffect(() => {
    if (isNew) return
    setOrder(undefined)
    reloadOrder()
    reloadItems()
    reloadPayments()
    reloadComments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Atomic fields (Select/Combobox, instant-commit -- no in-progress typed
  // draft that a reload from an unrelated action could stomp).
  useEffect(() => {
    if (isNew || !order) return
    setContactId(order.contact_id)
    setOpportunityId(order.opportunity_id ?? '')
    setStatus(order.status)
    setValidUntil(order.valid_until ?? '')
    setShippingAddressId(order.shipping_address_id ?? '')
    setBillingAddressId(order.billing_address_id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, order?.contact_id, order?.opportunity_id, order?.status, order?.valid_until, order?.shipping_address_id, order?.billing_address_id])

  // Items+shipping+tax baseline: only on order.id changing (a different
  // order loaded), or right after this block's own save (handled inline in
  // handleSaveItemsBlock) -- never in response to a reload triggered by
  // another block (changing contact, logging a payment, voiding).
  useEffect(() => {
    if (isNew || !order) return
    setShippingDraft(String(order.shipping))
    setSavedShipping(String(order.shipping))
    setTaxDraft(String(order.tax_total))
    setSavedTaxTotal(String(order.tax_total))
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
  const previewTotals = useMemo(() => computeOrderTotals(items, Number(shippingDraft) || 0, Number(taxDraft) || 0), [items, shippingDraft, taxDraft])

  const itemsDirty = savedItems !== null && !itemsEqual(items, savedItems)
  const shippingDirty = savedShipping !== null && shippingDraft !== savedShipping
  const taxDirty = savedTaxTotal !== null && taxDraft !== savedTaxTotal
  const blockDirty = itemsDirty || shippingDirty || taxDirty

  const contactError = isNew && touched && !isNotBlank(contactId) ? t('orders.drawer.errors.contactRequired') : undefined

  function handleContactSelect(newContactId: string | null) {
    setEditingContact(false)
    if (isNew) {
      setContactId(newContactId ?? '')
      return
    }
    // Contact is required on an existing order -- there's no way to clear
    // it from the picker (it's shown empty/value=null while editingContact
    // is true, see the card below), so a null here can only mean the user
    // reopened the picker and closed it without choosing anyone -- silently
    // ignored instead of autosaving an invalid null.
    if (!newContactId || !order || newContactId === order.contact_id) return
    setActionError(null)
    updateOrderFields(order.id, { contact_id: newContactId, opportunity_id: null, shipping_address_id: null, billing_address_id: null })
      .then(() => {
        setContactChangedNotice(true)
        reloadOrder()
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save')))
  }

  function handleOpportunitySelect(newId: string | null) {
    if (isNew) {
      setOpportunityId(newId ?? '')
      return
    }
    if (!order) return
    setActionError(null)
    updateOrderFields(order.id, { opportunity_id: newId || null })
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save')))
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
    setActionError(null)
    updateDeliveryStatus(order.id, newStatus)
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save')))
  }

  function handleValidUntilChange(value: string) {
    setValidUntil(value)
    if (isNew || !order) return
    setActionError(null)
    updateOrderFields(order.id, { valid_until: value || null })
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.drawer.errors.save')))
  }

  function handleAddressSelect(kind: 'shipping' | 'billing', addressId: string | null) {
    if (kind === 'shipping') setEditingShippingAddress(false)
    else setEditingBillingAddress(false)
    if (isNew) {
      if (kind === 'shipping') setShippingAddressId(addressId ?? '')
      else setBillingAddressId(addressId ?? '')
      return
    }
    if (!order) return
    setActionError(null)
    updateOrderFields(order.id, kind === 'shipping' ? { shipping_address_id: addressId || null } : { billing_address_id: addressId || null })
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.detail.errors.address')))
  }

  /** New address created inline (see the "+" next to each address field) --
   * auto-applies it to whichever role(s) it was flagged for if that role is
   * still unset, so creating a shipping address is normally a single action
   * instead of create-then-pick. Works the same in both modes; only the
   * persistence differs. */
  function handleAddressCreated(newAddress: ContactAddress) {
    setAddresses((prev) => [newAddress, ...prev])
    if (isNew) {
      if (newAddress.is_shipping && !shippingAddressId) setShippingAddressId(newAddress.id)
      if (newAddress.is_billing && !billingAddressId) setBillingAddressId(newAddress.id)
      return
    }
    if (!order) return
    const patch: Partial<OrderInput> = {}
    if (newAddress.is_shipping && !order.shipping_address_id) patch.shipping_address_id = newAddress.id
    if (newAddress.is_billing && !order.billing_address_id) patch.billing_address_id = newAddress.id
    if (Object.keys(patch).length === 0) return
    updateOrderFields(order.id, patch)
      .then(reloadOrder)
      .catch(() => {
        /* address is saved either way -- worst case the agent picks it manually */
      })
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

  async function handleSaveItemsBlock() {
    if (isNew || !order || !profile?.tenant_id) return
    if (hasIncompleteVariantSelection(items, products)) {
      setActionError(t('orders.itemsEditor.variantRequired'))
      return
    }
    setActionError(null)
    setSavingItems(true)
    try {
      await updateOrderItemsAndTotals(order.id, profile.tenant_id, items, Number(shippingDraft) || 0, Number(taxDraft) || 0)
      setSavedItems(items)
      setSavedShipping(shippingDraft)
      setSavedTaxTotal(taxDraft)
      reloadOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('orders.detail.errors.items'))
    } finally {
      setSavingItems(false)
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
      const input: OrderInput = {
        tenant_id: profile.tenant_id,
        contact_id: contactId,
        opportunity_id: opportunityId || null,
        status,
        shipping: Number(shippingDraft) || 0,
        tax_total: Number(taxDraft) || 0,
        valid_until: validUntil || null,
        shipping_address_id: shippingAddressId || null,
        billing_address_id: billingAddressId || null,
      }
      const created = await createOrder(input, validItems)
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
      const comment = await createComment(profile.tenant_id, id, commentDraft.trim())
      if (commentAttachment) {
        try {
          const attachment = await uploadOrderCommentAttachment(profile.tenant_id, commentAttachment, comment.id)
          setAttachmentsByComment((prev) => ({ ...prev, [comment.id]: [attachment] }))
        } catch (attachmentErr) {
          console.error('No se pudo subir la imagen del comentario', attachmentErr)
        }
      }
      setCommentDraft('')
      setCommentAttachment(null)
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
              <p className="truncate font-medium text-brand-800">
                {selected.line1}
                {selected.line2 ? `, ${selected.line2}` : ''}
              </p>
              {(selected.city || selected.state_province || selected.country) && (
                <p className="truncate text-xs text-brand-400">{[selected.city, selected.state_province, selected.country].filter(Boolean).join(', ')}</p>
              )}
            </div>
            <Button type="button" variant="default" size="icon-sm" onClick={() => setEditing(true)} aria-label={t('orders.detail.changeAddressAria')} className="shrink-0">
              <PencilIcon width={12} height={12} />
            </Button>
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
              className="min-w-0 flex-1"
              triggerClassName="min-w-0 flex-1 shrink"
            />
            <Button
              type="button"
              variant="default"
              size="icon"
              onClick={() => setAddressDrawerOpen(true)}
              disabled={!contactId}
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

  const itemsSaveAction = !isNew && blockDirty ? (
    <Button size="sm" onClick={handleSaveItemsBlock} disabled={savingItems}>
      {savingItems ? t('common.actions.saving') : t('common.actions.saveChanges')}
    </Button>
  ) : undefined

  const showPayments = (isNew ? status : order?.status) !== 'cotizacion'
  const showTasks = !isNew && !!relatedTasks && relatedTasks.length > 0
  const hasSidePanel = showPayments || showTasks

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
                  {t(PAYMENT_METHOD_LABEL_KEY[p.method])} · {formatDate(p.paid_at)}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="font-medium text-brand-800">{formatCurrency(p.amount, p.currency)}</span>
                  <button type="button" onClick={() => setDeletePaymentId(p.id)} className="text-brand-300 hover:text-red-600" aria-label={t('orders.detail.deletePaymentAria')}>
                    <TrashIcon width={11} height={11} />
                  </button>
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
                      <p className="truncate font-medium text-brand-800">{selectedContact.full_name}</p>
                      <p className="truncate text-xs text-brand-400">{[selectedContact.nit ? `NIT ${selectedContact.nit}` : null, selectedContact.phone].filter(Boolean).join(' · ')}</p>
                    </div>
                    <Button type="button" variant="default" size="icon-sm" onClick={() => setEditingContact(true)} aria-label={t('orders.detail.changeContactAria')} className="shrink-0">
                      <PencilIcon width={12} height={12} />
                    </Button>
                  </div>
                ) : (
                  <ComboboxFilter
                    options={contacts.map((c) => ({ id: c.id, label: c.full_name }))}
                    value={null}
                    onChange={handleContactSelect}
                    placeholder={t('orders.drawer.fields.selectPlaceholder')}
                    searchPlaceholder={t('orders.detail.searchContact')}
                    emptyLabel={t('orders.detail.noContactResults')}
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
                  <Label>{t('orders.drawer.fields.deliveryStatus')}</Label>
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
        {/* 3. Resumen de la orden -- Impuestos/Envío se editan acá (mismo
            guardado por lote que Ítems, ver itemsSaveAction), Subtotal/
            Descuentos/Total son derivados de los ítems. */}
        <StatCard title={t('orders.detail.orderSummary')} action={itemsSaveAction}>
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-brand-500">
              <span>{t('orders.detail.subtotal')}</span>
              <span className="font-medium text-brand-700">{formatCurrency(previewTotals.subtotal, order?.currency ?? 'COP')}</span>
            </div>
            {previewTotals.discountTotal > 0 && (
              <div className="flex items-center justify-between text-brand-500">
                <span>{t('orders.detail.discounts')}</span>
                <span className="font-medium text-emerald-600">-{formatCurrency(previewTotals.discountTotal, order?.currency ?? 'COP')}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <Label className="shrink-0 text-xs text-brand-500">{t('orders.drawer.fields.tax')}</Label>
              <CurrencyInput value={taxDraft} onChange={(e) => setTaxDraft(e.target.value)} className="h-7 w-28 text-right text-xs" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label className="shrink-0 text-xs text-brand-500">{t('orders.drawer.fields.shipping')}</Label>
              <CurrencyInput value={shippingDraft} onChange={(e) => setShippingDraft(e.target.value)} className="h-7 w-28 text-right text-xs" />
            </div>
            <div className="flex items-center justify-between border-t border-brand-100 pt-1.5">
              <span className="text-sm font-bold text-brand-800">{t('orders.detail.total')}</span>
              <span className="text-base font-bold text-emerald-600">{formatCurrency(previewTotals.total, order?.currency ?? 'COP')}</span>
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
                  attachmentsByComment={attachmentsByComment}
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
                        <ImageAttachmentPicker file={commentAttachment} onChange={setCommentAttachment} />
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
              {order.status === 'confirmada' && (
                <Button variant="outline" size="sm" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingVoid(true)}>
                  {t('orders.detail.voidAction')}
                </Button>
              )}
            </div>
          </div>
        )
      )}

      {actionError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}

      {detailsContent}

      {profile?.tenant_id && contactId && (
        <AddressDrawer open={addressDrawerOpen} onClose={() => setAddressDrawerOpen(false)} tenantId={profile.tenant_id} contactId={contactId} onSaved={handleAddressCreated} />
      )}

      {!isNew && order && profile?.tenant_id && (
        <PaymentDrawer open={paymentDrawerOpen} onClose={() => setPaymentDrawerOpen(false)} tenantId={profile.tenant_id} orderId={order.id} onSaved={reloadPayments} />
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

      <StockShortfallDialog shortfalls={stockShortfalls} open={shortfallDialogOpen} onClose={() => setShortfallDialogOpen(false)} />
    </div>
  )
}
