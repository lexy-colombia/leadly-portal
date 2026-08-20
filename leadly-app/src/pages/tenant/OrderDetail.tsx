import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getOrder, listOrderItems, updateOrderStatus, updateOrderFields, updateOrderItemsAndTotals, hasIncompleteVariantSelection, ORDER_STATUS_LABEL_KEY } from '../../lib/api/orders'
import type { OrderDetail, OrderItemInput } from '../../lib/api/orders'
import { listAddressesForContact } from '../../lib/api/addresses'
import { listProducts } from '../../lib/api/products'
import type { ProductWithImages } from '../../lib/api/products'
import { listPaymentsForOrder, deletePayment, PAYMENT_METHOD_LABEL_KEY } from '../../lib/api/orderPayments'
import { listCommentsForOrder, createComment } from '../../lib/api/orderComments'
import type { OrderCommentWithAuthor } from '../../lib/api/orderComments'
import { listAttachmentsForOrderComments, uploadOrderCommentAttachment } from '../../lib/api/attachments'
import { listTasksForOpportunity } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import type { ContactAddress, SalesOrderPayment, Attachment, OrderStatus } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { Badge, Button, InitialsAvatar, PageSpinner, Select, Textarea } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { ImageAttachmentPicker } from '@/components/molecules'
import { SignedImage } from '@/components/molecules'
import { AlertIcon, ClockIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { OrderItemsEditor } from './orders/OrderItemsEditor'
import { PaymentDrawer } from './orders/PaymentDrawer'
import { AddressDrawer } from './clients/AddressDrawer'

const STATUS_TONE: Record<OrderStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  cotizacion: 'neutral',
  confirmada: 'warning',
  en_proceso: 'warning',
  entregada: 'success',
  cancelada: 'danger',
}

function addressLabel(a: ContactAddress): string {
  return `${a.label ? `${a.label} — ` : ''}${a.line1}${a.city ? `, ${a.city}` : ''}`
}

function itemsEqual(a: OrderItemInput[], b: OrderItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
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

/** Bold label above its value -- the repeating unit of the detail-page info
 * grid (Cliente / Direcciones / Pagos columns), replicated field by field.
 * `action` is an optional small control next to the label (e.g. "+ nueva
 * dirección"). */
function InfoField({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-brand-800">{label}</p>
        {action}
      </div>
      <div className="mt-0.5 text-sm text-brand-600">{children}</div>
    </div>
  )
}

function VerticalDivider() {
  return <div className="hidden w-px self-stretch bg-brand-100 lg:block" />
}

/** Same small pill used across the CRM (ClientDetail.tsx notes/PQR) to
 * mark something the AI created on its own, so an agent can tell it apart
 * from what a human entered. */
function AiBadge({ label }: { label: string }) {
  return <span className="shrink-0 rounded-full bg-accent-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-700">{label}</span>
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const [order, setOrder] = useState<OrderDetail | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<OrderItemInput[] | null>(null)
  const [savedItems, setSavedItems] = useState<OrderItemInput[] | null>(null)
  const [products, setProducts] = useState<ProductWithImages[]>([])
  const [savingItems, setSavingItems] = useState(false)
  const [addresses, setAddresses] = useState<ContactAddress[]>([])
  const [savingAddress, setSavingAddress] = useState<'shipping' | 'billing' | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [payments, setPayments] = useState<SalesOrderPayment[] | null>(null)
  const [comments, setComments] = useState<OrderCommentWithAuthor[] | null>(null)
  const [attachmentsByComment, setAttachmentsByComment] = useState<Record<string, Attachment[]>>({})
  const [relatedTasks, setRelatedTasks] = useState<TaskWithRelations[] | null>(null)
  const [commentsPage, setCommentsPage] = useState(1)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentAttachment, setCommentAttachment] = useState<File | null>(null)
  const [savingComment, setSavingComment] = useState(false)
  const [paymentDrawerOpen, setPaymentDrawerOpen] = useState(false)
  const [addressDrawerOpen, setAddressDrawerOpen] = useState(false)
  const [deletePaymentId, setDeletePaymentId] = useState<string | null>(null)
  const [confirmingVoid, setConfirmingVoid] = useState(false)
  const [voiding, setVoiding] = useState(false)

  function reloadOrder() {
    if (!id) return
    getOrder(id)
      .then((data) => {
        setOrder(data)
        setNotesDraft(data?.notes ?? '')
      })
      .catch((err) => setError(err.message ?? t('orders.detail.loadError')))
  }

  function reloadItems() {
    if (!id) return
    listOrderItems(id).then((data) => {
      const mapped = data.map((i) => ({
        product_id: i.product_id,
        product_name: i.product_name,
        sku: i.sku,
        quantity: i.quantity,
        unit_price: i.unit_price,
        discount_percentage: i.discount_percentage,
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
    if (!id) return
    setOrder(undefined)
    reloadOrder()
    reloadItems()
    reloadPayments()
    reloadComments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (order === undefined || order === null) return
    if (order.opportunity_id) listTasksForOpportunity(order.opportunity_id).then(setRelatedTasks).catch(() => setRelatedTasks([]))
    if (profile?.tenant_id)
      listProducts(profile.tenant_id, { page: 1, pageSize: 1000 })
        .then(({ data }) => setProducts(data))
        .catch(() => {})
    if (order.contact_id) listAddressesForContact(order.contact_id).then(setAddresses).catch(() => setAddresses([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, profile?.tenant_id])

  const commentsPageData = useMemo(() => paginate(comments ?? [], commentsPage), [comments, commentsPage])
  const totalPaid = useMemo(() => (payments ?? []).reduce((sum, p) => sum + p.amount, 0), [payments])
  const totalQuantity = useMemo(() => (items ?? []).reduce((sum, i) => sum + i.quantity, 0), [items])
  const itemsDirty = items !== null && savedItems !== null && !itemsEqual(items, savedItems)
  const notesDirty = order !== null && order !== undefined && notesDraft !== (order.notes ?? '')

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

  async function handleSaveNotes() {
    if (!id) return
    setSavingNotes(true)
    try {
      await updateOrderFields(id, { notes: notesDraft.trim() || null })
      reloadOrder()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orders.detail.errors.notes'))
    } finally {
      setSavingNotes(false)
    }
  }

  async function handleAddressChange(kind: 'shipping' | 'billing', addressId: string) {
    if (!id) return
    setSavingAddress(kind)
    try {
      await updateOrderFields(id, kind === 'shipping' ? { shipping_address_id: addressId || null } : { billing_address_id: addressId || null })
      reloadOrder()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orders.detail.errors.address'))
    } finally {
      setSavingAddress(null)
    }
  }

  /** New address created inline (see the "+" next to each address Select) --
   * auto-applies it to whichever role(s) it was flagged for (is_shipping/
   * is_billing) if that role is still unset on this order, so creating a
   * shipping address is normally a single action instead of create-then-pick. */
  async function handleAddressCreated(newAddress: ContactAddress) {
    setAddresses((prev) => [newAddress, ...prev])
    if (!id) return
    const patch: { shipping_address_id?: string; billing_address_id?: string } = {}
    if (newAddress.is_shipping && !order?.shipping_address_id) patch.shipping_address_id = newAddress.id
    if (newAddress.is_billing && !order?.billing_address_id) patch.billing_address_id = newAddress.id
    if (Object.keys(patch).length === 0) return
    try {
      await updateOrderFields(id, patch)
      reloadOrder()
    } catch {
      /* address is saved either way -- worst case the agent picks it manually from the Select */
    }
  }

  async function handleSaveItems() {
    if (!id || !profile?.tenant_id || !items) return
    if (hasIncompleteVariantSelection(items, products)) {
      setError(t('orders.itemsEditor.variantRequired'))
      return
    }
    setSavingItems(true)
    try {
      await updateOrderItemsAndTotals(id, profile.tenant_id, items, order?.shipping ?? 0, order?.tax_total ?? 0)
      reloadOrder()
      reloadItems()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orders.detail.errors.items'))
    } finally {
      setSavingItems(false)
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
      // Never deletes -- just moves status to 'cancelada' (stays visible,
      // keeps its full history).
      await updateOrderStatus(order.id, 'cancelada')
      setConfirmingVoid(false)
      reloadOrder()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orders.detail.errors.void'))
      setConfirmingVoid(false)
    } finally {
      setVoiding(false)
    }
  }

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
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

  const balance = Math.max(0, order.total - totalPaid)

  return (
    <div className="space-y-3">
      {/* Sin breadcrumb propio -- AppShell ya renderiza "← Orders" en el
          header del layout a partir de la ruta (resolvePageTitle). */}
      <Card padded={false} className="overflow-hidden">
        {/* Fila 1: número + estado a la izquierda, fecha y "Anular" a la derecha */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-brand-800">{t('orders.detail.title', { number: order.number })}</span>
            <Badge tone={STATUS_TONE[order.status]}>{t(ORDER_STATUS_LABEL_KEY[order.status])}</Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-brand-500">
            <span className="flex items-center gap-1">
              <ClockIcon width={12} height={12} /> {formatDateTime(order.created_at, language)}
            </span>
            {order.created_by_profile && <span>· {order.created_by_profile.full_name}</span>}
            {order.status !== 'cancelada' && (
              <button type="button" onClick={() => setConfirmingVoid(true)} className="font-medium text-red-600 hover:underline">
                {t('orders.detail.voidAction')}
              </button>
            )}
          </div>
        </div>

        {/* Fila 2: Cliente | Direcciones | Pagos -- tres columnas separadas por línea vertical */}
        <div className="grid grid-cols-1 gap-4 border-t border-brand-100 p-3 sm:p-4 lg:grid-cols-[1fr_1px_1fr_1px_1fr]">
          <div className="space-y-2.5">
            <InfoField label={t('orders.detail.client')}>
              {order.contact ? (
                <>
                  <Link to={`/app/clients/${order.contact.id}`} className="font-medium text-accent-600 hover:underline">
                    {order.contact.full_name}
                  </Link>
                  <span className="text-brand-400"> · {order.contact.phone}</span>
                </>
              ) : (
                '—'
              )}
            </InfoField>
            <InfoField label={t('orders.detail.opportunity')}>{order.opportunity?.title ?? '—'}</InfoField>
          </div>

          <VerticalDivider />

          <div className="space-y-2.5">
            <InfoField
              label={t('orders.detail.shipping')}
              action={
                <button type="button" onClick={() => setAddressDrawerOpen(true)} className="text-brand-400 hover:text-accent-600" aria-label={t('orders.detail.newAddressAria')}>
                  <PlusIcon width={12} height={12} />
                </button>
              }
            >
              <Select
                value={order.shipping_address_id ?? ''}
                disabled={savingAddress === 'shipping'}
                onChange={(e) => handleAddressChange('shipping', e.target.value)}
                className="!py-1 text-xs"
              >
                <option value="">{t('orders.detail.noAddress')}</option>
                {addresses
                  .filter((a) => a.is_shipping)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {addressLabel(a)}
                    </option>
                  ))}
              </Select>
            </InfoField>
            <InfoField
              label={t('orders.detail.billing')}
              action={
                <button type="button" onClick={() => setAddressDrawerOpen(true)} className="text-brand-400 hover:text-accent-600" aria-label={t('orders.detail.newAddressAria')}>
                  <PlusIcon width={12} height={12} />
                </button>
              }
            >
              <Select
                value={order.billing_address_id ?? ''}
                disabled={savingAddress === 'billing'}
                onChange={(e) => handleAddressChange('billing', e.target.value)}
                className="!py-1 text-xs"
              >
                <option value="">{t('orders.detail.noAddress')}</option>
                {addresses
                  .filter((a) => a.is_billing)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {addressLabel(a)}
                    </option>
                  ))}
              </Select>
            </InfoField>
          </div>

          <VerticalDivider />

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-bold text-brand-800">{t('orders.detail.payments')}</p>
              <button
                type="button"
                onClick={() => setPaymentDrawerOpen(true)}
                className="flex h-5 w-5 items-center justify-center rounded-md border border-brand-200 text-brand-500 hover:bg-brand-50"
                aria-label={t('orders.detail.registerPaymentAria')}
              >
                <PlusIcon width={11} height={11} />
              </button>
            </div>

            {balance > 0 ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700">
                <AlertIcon width={13} height={13} /> {t('orders.detail.pendingBalance', { amount: formatCurrency(balance, order.currency) })}
              </div>
            ) : (
              payments &&
              payments.length > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700">{t('orders.detail.fullyPaid')}</div>
              )
            )}

            {payments && payments.length > 0 && (
              <ul className="mt-1.5 space-y-1">
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
          </div>
        </div>

        {/* Fila 3: Comentarios | Notas -- dos columnas */}
        <div className="grid grid-cols-1 gap-4 border-t border-brand-100 p-3 sm:p-4 lg:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-bold text-brand-800">{t('orders.detail.comments')}</p>
            <form onSubmit={handleAddComment} className="mb-2 rounded-lg border border-brand-100 bg-brand-50/40 p-2 focus-within:border-accent-300">
              <Textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                placeholder={t('orders.detail.commentPlaceholder')}
                rows={2}
                className="!resize-none !border-0 !bg-transparent !p-0 !shadow-none focus:!ring-0"
              />
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <ImageAttachmentPicker file={commentAttachment} onChange={setCommentAttachment} />
                <Button type="submit" variant="secondary" disabled={savingComment || !commentDraft.trim()} className="!px-2.5 !py-1 text-xs">
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
          </div>

          <div>
            <p className="mb-1.5 text-xs font-bold text-brand-800">{t('orders.detail.notes')}</p>
            <Textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={2} placeholder={t('orders.detail.notesPlaceholder')} className="text-sm" />
            {notesDirty && (
              <div className="mt-1 flex justify-end">
                <Button variant="secondary" onClick={handleSaveNotes} disabled={savingNotes} className="!px-2.5 !py-1 text-xs">
                  {savingNotes ? t('common.actions.saving') : t('orders.detail.saveNote')}
                </Button>
              </div>
            )}

            {relatedTasks && relatedTasks.length > 0 && (
              <div className="mt-3 border-t border-brand-100 pt-3">
                <p className="mb-1.5 text-xs font-bold text-brand-800">{t('orders.detail.relatedTasks')}</p>
                <ul className="space-y-1">
                  {relatedTasks.map((task) => (
                    <li key={task.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate text-brand-600">{task.title}</span>
                      <Badge tone={task.status === 'completada' ? 'success' : 'warning'}>
                        {task.status === 'completada' ? t('orders.detail.taskDone') : t('orders.detail.taskPending')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Fila 4: Products (editable) + resumen de la orden abajo a la derecha */}
        <div className="border-t border-brand-100 p-3 sm:p-4">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-bold text-brand-800">{t('orders.detail.products')}</p>
            {itemsDirty && (
              <Button variant="secondary" onClick={handleSaveItems} disabled={savingItems} className="!px-2.5 !py-1 text-xs">
                {savingItems ? t('common.actions.saving') : t('common.actions.saveChanges')}
              </Button>
            )}
          </div>

          {!items && <PageSpinner />}
          {items && <OrderItemsEditor items={items} products={products} onChange={setItems} />}
          {items && items.length === 0 && <EmptyState>{t('orders.detail.noProducts')}</EmptyState>}
          {items && items.length > 0 && (
            <p className="mt-1.5 text-xs text-brand-400">
              {t(items.length === 1 ? 'orders.detail.itemsSummary.singular' : 'orders.detail.itemsSummary.plural', { count: items.length, qty: totalQuantity })}
            </p>
          )}

          <div className="mt-3 flex justify-end">
            <div className="w-full rounded-xl border border-brand-100 p-3 sm:w-72">
              <p className="mb-0.5 text-xs font-bold text-brand-800">{t('orders.detail.orderSummary')}</p>
              <div className="divide-y divide-brand-100 text-sm">
                <div className="flex justify-between py-1.5 text-brand-500">
                  <span>{t('orders.detail.subtotal')}</span>
                  <span className="text-brand-700">{formatCurrency(order.subtotal, order.currency)}</span>
                </div>
                {order.discount_total > 0 && (
                  <div className="flex justify-between py-1.5 text-brand-500">
                    <span>{t('orders.detail.discounts')}</span>
                    <span className="text-brand-700">-{formatCurrency(order.discount_total, order.currency)}</span>
                  </div>
                )}
                {order.tax_total > 0 && (
                  <div className="flex justify-between py-1.5 text-brand-500">
                    <span>{t('orders.detail.taxes')}</span>
                    <span className="text-brand-700">{formatCurrency(order.tax_total, order.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between py-1.5 text-brand-500">
                  <span>{t('orders.detail.shipping')}</span>
                  <span className="text-brand-700">{formatCurrency(order.shipping, order.currency)}</span>
                </div>
                <div className="flex justify-between py-1.5 text-sm font-bold text-brand-800">
                  <span>{t('orders.detail.total')}</span>
                  <span>{formatCurrency(order.total, order.currency)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {profile?.tenant_id && order.contact && (
        <>
          <PaymentDrawer
            open={paymentDrawerOpen}
            onClose={() => setPaymentDrawerOpen(false)}
            tenantId={profile.tenant_id}
            orderId={order.id}
            onSaved={reloadPayments}
          />
          <AddressDrawer
            open={addressDrawerOpen}
            onClose={() => setAddressDrawerOpen(false)}
            tenantId={profile.tenant_id}
            contactId={order.contact.id}
            onSaved={handleAddressCreated}
          />
        </>
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
    </div>
  )
}
