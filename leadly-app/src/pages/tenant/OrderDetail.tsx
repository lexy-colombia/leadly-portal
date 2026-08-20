import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MoreHorizontalIcon, ScanLineIcon, UploadIcon, XIcon } from 'lucide-react'
import {
  createOrder,
  deleteOrder,
  getOrder,
  hasIncompleteVariantSelection,
  listOrderItems,
  updateOrderFields,
  updateOrderItemsAndTotals,
  updateOrderStatus,
  computeOrderTotals,
  ORDER_STATUS_LABEL_KEY,
} from '../../lib/api/orders'
import type { OrderDetail as OrderDetailType, OrderInput, OrderItemInput } from '../../lib/api/orders'
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
import type { ContactAddress, SalesOrderPayment, Attachment, OrderStatus, ProductCategory, Brand, Warehouse } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { isNotBlank } from '../../lib/validation'
import { FieldError, InitialsAvatar, PageSpinner } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput, ImageAttachmentPicker, Pagination, SignedImage } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { ClockIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { OrderItemsEditor } from './orders/OrderItemsEditor'
import { PaymentDrawer } from './orders/PaymentDrawer'
import { AddressDrawer } from './clients/AddressDrawer'

const ORDER_STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  cotizacion: 'border-transparent bg-slate-100 text-slate-600',
  confirmada: 'border-transparent bg-amber-100 text-amber-700',
  en_proceso: 'border-transparent bg-amber-100 text-amber-700',
  entregada: 'border-transparent bg-emerald-100 text-emerald-700',
  cancelada: 'border-transparent bg-red-100 text-red-700',
}

function addressLabel(a: ContactAddress): string {
  return `${a.label ? `${a.label} — ` : ''}${a.line1}${a.city ? `, ${a.city}` : ''}`
}

function itemsEqual(a: OrderItemInput[], b: OrderItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** No reverse transitions -- once a cotización becomes a venta it can't go
 * back, and 'cancelada' is terminal. A brand new order can start directly
 * at any non-cancelada status (an instant/walk-in sale skips the quote
 * phase entirely). */
function availableStatusOptions(currentStatus: OrderStatus | null): OrderStatus[] {
  if (!currentStatus || currentStatus === 'cotizacion') return ['cotizacion', 'confirmada', 'en_proceso', 'entregada', 'cancelada']
  if (currentStatus === 'cancelada') return ['cancelada']
  return ['confirmada', 'en_proceso', 'entregada', 'cancelada']
}

const PAGE_SIZE = 6

function paginate<T>(items: T[], page: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  return { items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), totalPages }
}

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string | null, language: Language): string {
  if (!iso) return '—'
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatDateTime(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleString(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
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
  const [status, setStatus] = useState<OrderStatus>('cotizacion')
  const [validUntil, setValidUntil] = useState('')
  const [shippingAddressId, setShippingAddressId] = useState('')
  const [billingAddressId, setBillingAddressId] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [contactChangedNotice, setContactChangedNotice] = useState(false)
  // Contacto shows either the search combobox or (once picked) a compact
  // read-only card with its info -- the "x" on the card switches back to
  // the combobox instead of clearing contact_id outright (required field,
  // see handleContactSelect's guard against nulling it on an existing
  // order); the combobox itself is rendered with value=null while in this
  // mode so it doesn't show its own redundant "x" on top of the old pick.
  const [editingContact, setEditingContact] = useState(false)
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

  // ----- payments / comments (edit mode only) -----
  const [payments, setPayments] = useState<SalesOrderPayment[] | null>(null)
  const [comments, setComments] = useState<OrderCommentWithAuthor[] | null>(null)
  const [attachmentsByComment, setAttachmentsByComment] = useState<Record<string, Attachment[]>>({})
  const [commentsPage, setCommentsPage] = useState(1)
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

  // Notes get their own effect (Textarea, real risk of an in-progress typed
  // draft) -- only resyncs when the *value* actually changed, never on a
  // reload triggered by something else on the page.
  useEffect(() => {
    if (isNew || !order) return
    setNotesDraft(order.notes ?? '')
  }, [order?.id, order?.notes])

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
  const commentsPageData = useMemo(() => paginate(comments ?? [], commentsPage), [comments, commentsPage])
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

  function handleStatusSelect(newStatus: OrderStatus) {
    if (isNew) {
      setStatus(newStatus)
      return
    }
    if (!order) return
    setActionError(null)
    updateOrderStatus(order.id, newStatus)
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

  function handleNotesBlur() {
    if (isNew || !order) return
    if (notesDraft === (order.notes ?? '')) return
    setActionError(null)
    updateOrderFields(order.id, { notes: notesDraft.trim() || null })
      .then(reloadOrder)
      .catch((err) => setActionError(err instanceof Error ? err.message : t('orders.detail.errors.notes')))
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

    setCreating(true)
    try {
      const input: OrderInput = {
        tenant_id: profile.tenant_id,
        contact_id: contactId,
        opportunity_id: opportunityId || null,
        status,
        shipping: Number(shippingDraft) || 0,
        tax_total: Number(taxDraft) || 0,
        notes: notesDraft.trim() || null,
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
    return (
      <div>
        <Label>{t(kind === 'shipping' ? 'orders.detail.shipping' : 'orders.detail.billing')}</Label>
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
      </div>
    )
  }

  const itemsSaveAction = !isNew && blockDirty ? (
    <Button size="sm" onClick={handleSaveItemsBlock} disabled={savingItems}>
      {savingItems ? t('common.actions.saving') : t('common.actions.saveChanges')}
    </Button>
  ) : undefined

  const detailsContent = (
    <div className="space-y-4">
      {/* 1. Cliente y direcciones */}
      <StatCard title={t('orders.detail.sections.clientAndAddresses')}>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div>
            <Label>{t('orders.drawer.fields.contact')}</Label>
            {contactId && !editingContact && selectedContact ? (
              <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-brand-100 bg-brand-50/40 px-3 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-800">{selectedContact.full_name}</p>
                  <p className="truncate text-xs text-brand-500">{[selectedContact.nit ? `NIT ${selectedContact.nit}` : null, selectedContact.phone].filter(Boolean).join(' · ')}</p>
                </div>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditingContact(true)} aria-label={t('orders.detail.changeContactAria')} className="shrink-0">
                  <XIcon className="size-3.5" />
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
          {addressField('shipping')}
          {addressField('billing')}
        </div>

        {contactChangedNotice && <p className="mt-2 text-xs text-amber-600">{t('orders.detail.contactChangedNotice')}</p>}
        {contactId && addresses.length === 0 && <p className="mt-2 text-xs text-brand-400">{t('orders.drawer.noAddressesHint')}</p>}

        <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 border-t border-brand-100 pt-3 sm:grid-cols-3">
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
          <div>
            <Label>{t('orders.drawer.fields.status')}</Label>
            <Select value={status} onValueChange={(v) => handleStatusSelect(v as OrderStatus)} disabled={!isNew && order?.status === 'cancelada'}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableStatusOptions(isNew ? null : (order?.status ?? null)).map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(ORDER_STATUS_LABEL_KEY[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isNew && order?.status === 'cancelada' && <p className="mt-1 text-xs text-brand-400">{t('orders.drawer.cancelledNotice')}</p>}
          </div>
          <div>
            <Label>{t('orders.drawer.fields.validUntil')}</Label>
            <Input type="date" value={validUntil} onChange={(e) => handleValidUntilChange(e.target.value)} className="mt-1" disabled={!isNew && order?.status === 'cancelada'} />
          </div>
        </div>
      </StatCard>

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
          currency={order?.currency ?? 'COP'}
          onChange={setItems}
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

        {/* 4. Notas adicionales */}
        <StatCard title={t('orders.detail.notes')}>
          <p className="mb-2 text-xs text-brand-400">{t('orders.detail.notesHint')}</p>
          <Textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} onBlur={handleNotesBlur} rows={4} placeholder={t('orders.detail.notesPlaceholder')} />
        </StatCard>
      </div>

      {/* Pagos + Tareas relacionadas -- solo modo edición, no tienen
          equivalente en la referencia (no existe todavía un pedido creado
          para registrarles pagos). */}
      {!isNew && order && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                      {t(PAYMENT_METHOD_LABEL_KEY[p.method])} · {formatDate(p.paid_at, language)}
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

          {relatedTasks && relatedTasks.length > 0 && (
            <StatCard title={t('orders.detail.relatedTasks')}>
              <ul className="space-y-1.5">
                {relatedTasks.map((task) => (
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
  )

  const commentsContent = (
    <StatCard title={t('orders.detail.comments')}>
      <form onSubmit={handleAddComment} className="mb-3 rounded-lg border border-brand-100 bg-brand-50/40 p-2 focus-within:border-accent-300">
        <Textarea
          value={commentDraft}
          onChange={(e) => setCommentDraft(e.target.value)}
          placeholder={t('orders.detail.commentPlaceholder')}
          rows={2}
          className="resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <ImageAttachmentPicker file={commentAttachment} onChange={setCommentAttachment} />
          <Button type="submit" size="sm" disabled={savingComment || !commentDraft.trim()}>
            {savingComment ? t('common.actions.saving') : t('orders.detail.addComment')}
          </Button>
        </div>
      </form>

      {!comments && <PageSpinner />}
      {comments && comments.length === 0 && <p className="text-xs text-brand-400">{t('orders.detail.noComments')}</p>}
      {comments && comments.length > 0 && (
        <ul className="divide-y divide-brand-100">
          {commentsPageData.items.map((c) => (
            <li key={c.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
              <InitialsAvatar name={c.created_by_ai ? t('orders.detail.aiBadge') : (c.author?.full_name ?? t('orders.detail.agent'))} size="xs" />
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm text-brand-700">{c.content}</p>
                {attachmentsByComment[c.id]?.map((a) => <SignedImage key={a.id} storagePath={a.storage_path} className="mt-1 h-12 w-12" />)}
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-brand-400">
                  {c.created_by_ai ? t('orders.detail.aiAssistant') : (c.author?.full_name ?? t('orders.detail.agent'))} · {formatDateTime(c.created_at, language)}
                  {c.created_by_ai && <AiBadge label={t('orders.detail.aiBadge')} />}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={commentsPage} totalPages={commentsPageData.totalPages} onChange={setCommentsPage} />
    </StatCard>
  )

  return (
    <div className="space-y-4">
      {isNew ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-brand-800">{t('orders.drawer.newTitle')}</h1>
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
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-brand-800">{t('orders.detail.title', { number: order.number })}</h1>
                <Badge className={ORDER_STATUS_BADGE_CLASS[order.status]}>{t(ORDER_STATUS_LABEL_KEY[order.status])}</Badge>
              </div>
              <p className="mt-1 flex items-center gap-1 text-xs text-brand-500">
                <ClockIcon width={12} height={12} /> {formatDateTime(order.created_at, language)}
                {order.created_by_profile && <span>· {order.created_by_profile.full_name}</span>}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label={t('orders.detail.moreActionsAria')}>
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {order.status !== 'cancelada' && <DropdownMenuItem onSelect={() => setConfirmingVoid(true)}>{t('orders.detail.voidAction')}</DropdownMenuItem>}
                {order.status === 'cotizacion' && (
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                    {t('orders.detail.deleteAction')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      )}

      {actionError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>}

      {isNew ? (
        detailsContent
      ) : (
        <Tabs defaultValue="detalles">
          <TabsList>
            <TabsTrigger value="detalles">{t('orders.detail.tabs.details')}</TabsTrigger>
            <TabsTrigger value="comentarios">{t('orders.detail.tabs.comments')}</TabsTrigger>
          </TabsList>
          <TabsContent value="detalles" className="mt-4">
            {detailsContent}
          </TabsContent>
          <TabsContent value="comentarios" className="mt-4">
            {commentsContent}
          </TabsContent>
        </Tabs>
      )}

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
    </div>
  )
}
