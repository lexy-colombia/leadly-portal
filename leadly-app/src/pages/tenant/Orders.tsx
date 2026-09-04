import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontalIcon } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useHeaderSearchSlot } from '@/contexts/HeaderSearchSlotContext'
import { formatDate, formatTime } from '../../lib/dates'
import { formatClientPhoneDisplay } from '../../lib/phone'
import {
  deleteOrder,
  listOrders,
  updateOrderStatus,
  ORDER_STATUS_LABEL_KEY,
  ORDER_STATUS_DOT_CLASS,
  DELIVERY_STATUS_LABEL_KEY,
  DELIVERY_STATUS_DOT_CLASS,
} from '../../lib/api/orders'
import type { OrderWithRelations } from '../../lib/api/orders'
import { listClients } from '../../lib/api/clients'
import { listPaymentsForTenant, PAYMENT_METHOD_LABEL_KEY } from '../../lib/api/orderPayments'
import type { Client, OrderStatus, OrderPaymentMethod, SalesOrder, SalesOrderPayment } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card, ComboboxFilter, EmptyState, FilterField, IconInput, Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { ChevronLeftIcon, PlusIcon, SearchIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { OrderPaymentMethodCell, StatusDotLine } from './orders/OrderTableCells'
import { SALES_CHANNEL_LABEL_KEY } from '../../lib/api/orders'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const PAGE_SIZE = 10

interface OrderFilters {
  status: OrderStatus | null
  channel: SalesOrder['sales_channel']
  contact: string | null
  dateFrom: string
  dateTo: string
}

// Same trigger sizing convention as Products.tsx/Clients.tsx's filter
// pills, so this list doesn't feel like a separate design system. Border
// bumped one step past the shared default (brand-200 instead of the
// component's own pale brand-100/--input) -- pedido explícito del usuario,
// esta vista se veía "muy en blanco" y necesitaba algo más de azul.
const FILTER_TRIGGER_CLASS = 'w-40 rounded-lg border-brand-300 text-xs'

/** YYYY-MM-DD de hoy, en hora local -- valor por defecto de "Desde"/"Hasta"
 * (pedido explícito del usuario: nada de un select de períodos, siempre los
 * dos calendarios, arrancando en el día actual). */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Estado "sin filtrar": el día de hoy, ningún estado/origen/cliente
 * elegido. Es a lo que vuelve "Borrar filtros" (una función, no una
 * constante: "hoy" cambia). */
function defaultOrderFilters(): OrderFilters {
  return { status: null, channel: null, contact: null, dateFrom: todayIso(), dateTo: todayIso() }
}

/** [start, end) del rango Desde/Hasta -- end es exclusivo para poder
 * expresar "hasta" como "el inicio del día siguiente" sin mezclar >= y >. */
function resolveDateRange(dateFrom: string, dateTo: string): { start: Date | null; end: Date | null } {
  const start = dateFrom ? new Date(`${dateFrom}T00:00:00`) : null
  const end = dateTo ? new Date(new Date(`${dateTo}T00:00:00`).getTime() + 24 * 60 * 60 * 1000) : null
  return { start, end }
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Tarjeta de resumen (Órdenes/Total vendido/Pagado/Pendiente/Ticket
 * promedio) -- compacta, solo etiqueta + valor, sin pie con porcentajes
 * (pedido explícito del usuario: "lo demás no importa"). */
function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-brand-100 bg-white px-2.5 py-1.5">
      <p className="truncate text-[10px] text-brand-400">{label}</p>
      <p className="truncate text-sm font-bold text-brand-800">{value}</p>
    </div>
  )
}

/** Una fila del desglose "Ingresos por método de pago" -- barra proporcional
 * al total vendido del período filtrado (no al método más alto, como
 * antes), con el porcentaje explícito junto a la barra, igual que la
 * referencia de diseño que trajo el usuario. */
function PaymentMethodRow({ label, amount, total, currency }: { label: string; amount: number; total: number; currency: string }) {
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 truncate text-xs text-brand-600">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-brand-100">
        <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs text-brand-500">{pct}%</span>
      <span className="w-24 shrink-0 text-right text-xs font-medium text-brand-800">{formatCurrency(amount, currency)}</span>
    </div>
  )
}

export function Orders() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const { slot: headerSearchSlot } = useHeaderSearchSlot()

  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [contacts, setContacts] = useState<Client[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Los filtros se editan en un borrador y no afectan la tabla hasta tocar
  // "Aplicar" (pedido explícito del usuario: nada de refiltrar en cada
  // click). Mismo criterio que el drawer de filtros de la tienda pública.
  // `channel` es por dónde entró el pedido (sales_channel): mostrador,
  // portal, IA de WhatsApp o tienda pública.
  const [draft, setDraft] = useState<OrderFilters>(defaultOrderFilters)
  const [filters, setFilters] = useState<OrderFilters>(defaultOrderFilters)
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(filters)
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(defaultOrderFilters())
  const [page, setPage] = useState(1)
  // First column, prep for a future bulk-actions bar -- no toolbar wired up
  // yet, just the ability to check rows. Selection is page-scoped: cleared
  // whenever the filtered set changes so it never holds an id that has
  // scrolled out of view.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Shared by both destructive actions (cancel a cotización / anular a
  // venta) -- only one of the two is ever offered per row (see the status
  // check in the actions menu), so one confirm-target is enough. A real
  // modal (not an inline button swap) so voiding a sale is a deliberate,
  // separate decision -- same convention as OrderDetail.tsx's own
  // anular/eliminar actions.
  const [confirmOrder, setConfirmOrder] = useState<OrderWithRelations | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [payments, setPayments] = useState<SalesOrderPayment[] | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(true)

  function reload() {
    if (!profile?.tenant_id) return
    listOrders(profile.tenant_id)
      .then(setOrders)
      .catch((err) => setError(err.message ?? t('orders.errors.load')))
  }

  useEffect(reload, [profile?.tenant_id])

  useEffect(() => {
    if (!profile?.tenant_id) return
    listClients(profile.tenant_id).then(setContacts).catch(() => {})
    // Resumen de ventas (ver salesSummary más abajo) -- todos los pagos del
    // tenant de una sola vez, igual que `orders` mismo, filtrado del lado
    // del cliente junto con `filtered` en vez de refetch por cada cambio de
    // filtro.
    listPaymentsForTenant(profile.tenant_id).then(setPayments).catch(() => setPayments([]))
  }, [profile?.tenant_id])

  const { start: periodStart, end: periodEnd } = useMemo(() => resolveDateRange(filters.dateFrom, filters.dateTo), [filters.dateFrom, filters.dateTo])

  const filtered = useMemo(() => {
    if (!orders) return null
    const term = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (filters.status && o.status !== filters.status) return false
      if (filters.channel && o.sales_channel !== filters.channel) return false
      if (filters.contact && o.contact_id !== filters.contact) return false
      const createdAt = new Date(o.created_at)
      if (periodStart && createdAt < periodStart) return false
      if (periodEnd && createdAt >= periodEnd) return false
      if (!term) return true
      return `ord-${o.number}`.includes(term) || (o.contact?.full_name ?? '').toLowerCase().includes(term)
    })
  }, [orders, filters, periodStart, periodEnd, search])

  // Ventas del período filtrado -- pedido explícito del usuario (referencia:
  // un POS de restaurante). Solo cuenta 'confirmada' (ventas reales, no
  // cotizaciones ni anuladas) sin importar qué status haya en el filtro de
  // arriba -- el resumen siempre es "de lo que de verdad se vendió". La
  // moneda se toma de la primera orden confirmada porque hoy todo el
  // dashboard asume una sola moneda por tenant (igual que el resto de la
  // pantalla, ver formatCurrency en las filas de la tabla).
  const salesSummary = useMemo(() => {
    if (!filtered || !payments) return null
    const confirmed = filtered.filter((o) => o.status === 'confirmada')
    const orderIds = new Set(confirmed.map((o) => o.id))
    const currency = confirmed[0]?.currency ?? 'COP'

    const paidByOrder = new Map<string, number>()
    const byMethod: Record<OrderPaymentMethod, number> = { efectivo: 0, transferencia: 0, tarjeta: 0, credito: 0, saldo_favor: 0, wompi: 0 }
    for (const p of payments) {
      if (!orderIds.has(p.order_id)) continue
      byMethod[p.method] += p.amount
      paidByOrder.set(p.order_id, (paidByOrder.get(p.order_id) ?? 0) + p.amount)
    }

    const total = confirmed.reduce((sum, o) => sum + o.total, 0)
    const pending = confirmed.reduce((sum, o) => sum + Math.max(0, o.total - (paidByOrder.get(o.id) ?? 0)), 0)
    const paid = total - pending

    return {
      count: confirmed.length,
      total,
      average: confirmed.length > 0 ? total / confirmed.length : 0,
      paid,
      pending,
      byMethod,
      currency,
    }
  }, [filtered, payments])

  // Desglose de métodos de pago por orden (columna "Métodos de pago" de la
  // tabla) -- se construye una sola vez a partir de `payments` (ya cargado
  // completo para todo el tenant, ver arriba) en vez de una consulta por
  // fila. Ordenado de mayor a menor monto para que el método principal de
  // cada orden aparezca primero.
  const paymentsByOrder = useMemo(() => {
    const map = new Map<string, { method: OrderPaymentMethod; amount: number }[]>()
    if (!payments) return map
    for (const p of payments) {
      const list = map.get(p.order_id) ?? []
      const existing = list.find((m) => m.method === p.method)
      if (existing) existing.amount += p.amount
      else list.push({ method: p.method, amount: p.amount })
      map.set(p.order_id, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.amount - a.amount)
    return map
  }, [payments])

  useEffect(() => {
    setPage(1)
    setSelectedIds(new Set())
  }, [filters, search])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  const allPageSelected = !!pageItems && pageItems.length > 0 && pageItems.every((o) => selectedIds.has(o.id))
  const somePageSelected = !!pageItems && pageItems.some((o) => selectedIds.has(o.id))

  function toggleSelectAll(checked: boolean) {
    if (!pageItems) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const o of pageItems) {
        if (checked) next.add(o.id)
        else next.delete(o.id)
      }
      return next
    })
  }

  function toggleSelectRow(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** Only reachable while status === 'cotizacion' (see actions menu) --
   * cancels it and removes it from view. A confirmed venta can never take
   * this path; see handleVoid. */
  async function handleCancelQuote(id: string) {
    setConfirming(true)
    setConfirmError(null)
    try {
      await deleteOrder(id)
      setOrders((prev) => (prev ? prev.filter((o) => o.id !== id) : prev))
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setConfirmOrder(null)
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : t('orders.errors.cancelQuote'))
    } finally {
      setConfirming(false)
    }
  }

  /** A venta (status 'confirmada') can't be deleted, only anulada -- status
   * moves to 'cancelada' (the stock-effect trigger restores the deducted
   * stock) but the row stays visible, never soft-deleted, since a sale is
   * a permanent record. */
  async function handleVoid(id: string) {
    setConfirming(true)
    setConfirmError(null)
    try {
      await updateOrderStatus(id, 'cancelada')
      reload()
      setConfirmOrder(null)
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : t('orders.errors.void'))
    } finally {
      setConfirming(false)
    }
  }

  if (!profile?.tenant_id) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-3">
      {headerSearchSlot &&
        createPortal(
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('orders.list.searchPlaceholder')}
            className="!w-64 !rounded-lg !py-1.5 text-xs"
          />,
          headerSearchSlot,
        )}

      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-brand-100 bg-brand-50/40 p-3">
        <FilterField label={t('orders.filters.labels.status')}>
          <ComboboxFilter
            options={(Object.keys(ORDER_STATUS_LABEL_KEY) as OrderStatus[]).map((s) => ({ id: s, label: t(ORDER_STATUS_LABEL_KEY[s]) }))}
            value={draft.status}
            onChange={(id) => setDraft((d) => ({ ...d, status: id as OrderStatus | null }))}
            placeholder={t('orders.filters.all')}
            searchPlaceholder={t('orders.filters.search')}
            emptyLabel={t('orders.filters.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('orders.filters.labels.channel')}>
          <ComboboxFilter
            options={(Object.keys(SALES_CHANNEL_LABEL_KEY) as Array<keyof typeof SALES_CHANNEL_LABEL_KEY>).map((c) => ({ id: c, label: t(SALES_CHANNEL_LABEL_KEY[c]) }))}
            value={draft.channel}
            onChange={(id) => setDraft((d) => ({ ...d, channel: id as SalesOrder['sales_channel'] }))}
            placeholder={t('orders.filters.all')}
            searchPlaceholder={t('orders.filters.search')}
            emptyLabel={t('orders.filters.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('orders.filters.labels.client')}>
          <ComboboxFilter
            options={contacts.map((c) => ({ id: c.id, label: c.full_name }))}
            value={draft.contact}
            onChange={(id) => setDraft((d) => ({ ...d, contact: id }))}
            placeholder={t('orders.filters.allContacts')}
            searchPlaceholder={t('orders.filters.searchContact')}
            emptyLabel={t('orders.filters.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('orders.filters.dateFrom')}>
          <Input
            type="date"
            value={draft.dateFrom}
            onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value }))}
            aria-label={t('orders.filters.dateFrom')}
            className="h-7 w-36 rounded-lg border-brand-300 text-xs"
          />
        </FilterField>
        <FilterField label={t('orders.filters.dateTo')}>
          <Input
            type="date"
            value={draft.dateTo}
            onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value }))}
            aria-label={t('orders.filters.dateTo')}
            className="h-7 w-36 rounded-lg border-brand-300 text-xs"
          />
        </FilterField>

        {/* Aplicar deshabilitado mientras el borrador sea igual a lo que ya
            está aplicado, y Borrar solo aparece si hay algo que borrar --
            así los dos botones dicen algo real sobre el estado actual. */}
        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          <Button type="button" size="sm" disabled={!filtersDirty} onClick={() => setFilters(draft)}>
            {t('orders.filters.apply')}
          </Button>
          {(filtersActive || filtersDirty) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                const cleared = defaultOrderFilters()
                setDraft(cleared)
                setFilters(cleared)
              }}
            >
              {t('orders.filters.clear')}
            </Button>
          )}
        </div>

        <span className="shrink-0 pb-1.5 text-xs text-brand-400">
          {filtered?.length ?? 0} {t((filtered?.length ?? 0) === 1 ? 'orders.count.singular' : 'orders.count.plural')}
        </span>

        <Button onClick={() => navigate('/app/sales/new')} size="sm" className="ml-auto self-center">
          <PlusIcon width={14} height={14} /> {t('orders.actions.newSale')}
        </Button>
      </div>

      {salesSummary && salesSummary.count > 0 && (
        <div className="space-y-2">
          {/* Siempre visibles, nunca detrás del toggle -- pedido explícito
              del usuario, a diferencia del desglose por método (ver abajo),
              que sí es "el detalle" que se abre/cierra. */}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
            <SummaryTile label={t('orders.summary.count')} value={String(salesSummary.count)} />
            <SummaryTile label={t('orders.summary.total')} value={formatCurrency(salesSummary.total, salesSummary.currency)} />
            <SummaryTile label={t('orders.summary.paid')} value={formatCurrency(salesSummary.paid, salesSummary.currency)} />
            <SummaryTile label={t('orders.summary.pending')} value={formatCurrency(salesSummary.pending, salesSummary.currency)} />
            <SummaryTile label={t('orders.summary.average')} value={formatCurrency(salesSummary.average, salesSummary.currency)} />
          </div>

          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            {/* Mismo fondo sombreado que la card de filtros (bg-brand-50/40)
                -- pedido explícito del usuario, en vez del azul oscuro que
                tenía antes. */}
            <button type="button" onClick={() => setSummaryOpen((v) => !v)} className="flex w-full items-center justify-between bg-brand-50/40 px-4 py-2.5 text-left">
              <span className="text-xs font-semibold tracking-wide text-brand-700 uppercase">{t('orders.summary.byMethod')}</span>
              <ChevronLeftIcon width={11} height={11} className={`text-brand-400 transition-transform ${summaryOpen ? 'rotate-90' : '-rotate-90'}`} />
            </button>
            {summaryOpen && (
              <div className="space-y-1.5 border-t border-brand-100 px-4 py-3">
                {/* Solo métodos que de verdad se usaron en este período --
                    pedido explícito del usuario, no tiene sentido mostrar
                    "Otro: $0" si ninguna orden lo usó. */}
                {(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[])
                  .filter((m) => m !== 'saldo_favor' && salesSummary.byMethod[m] > 0)
                  .map((m) => (
                    <PaymentMethodRow key={m} label={t(PAYMENT_METHOD_LABEL_KEY[m])} amount={salesSummary.byMethod[m]} total={salesSummary.total} currency={salesSummary.currency} />
                  ))}
                {salesSummary.pending > 0 && (
                  <PaymentMethodRow label={t('orders.summary.pending')} amount={salesSummary.pending} total={salesSummary.total} currency={salesSummary.currency} />
                )}
                {salesSummary.byMethod.saldo_favor > 0 && (
                  <PaymentMethodRow
                    label={t('orders.summary.storeCreditApplied')}
                    amount={salesSummary.byMethod.saldo_favor}
                    total={salesSummary.total}
                    currency={salesSummary.currency}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!orders && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>{orders && orders.length > 0 ? t('orders.empty.noMatch') : t('orders.empty.none')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-9">
                    <Checkbox
                      checked={allPageSelected ? true : somePageSelected ? 'indeterminate' : false}
                      onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      aria-label={t('orders.table.selectAll')}
                    />
                  </TableHead>
                  <TableHead>{t('orders.table.number')}</TableHead>
                  <TableHead>{t('orders.table.contact')}</TableHead>
                  <TableHead>{t('orders.table.status')}</TableHead>
                  <TableHead>{t('orders.table.delivery')}</TableHead>
                  <TableHead>{t('orders.table.paymentMethods')}</TableHead>
                  <TableHead>{t('orders.table.total')}</TableHead>
                  <TableHead>{t('orders.table.date')}</TableHead>
                  <TableHead className="text-right">{t('orders.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((order) => (
                  <TableRow key={order.id} onClick={() => navigate(`/app/sales/${order.id}`)} className="cursor-pointer">
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(order.id)}
                        onCheckedChange={(checked) => toggleSelectRow(order.id, checked === true)}
                        aria-label={t('orders.table.selectRow')}
                      />
                    </TableCell>
                    <TableCell className="text-xs font-medium text-brand-800">
                      ORD-{order.number}
                      {order.sales_channel && (
                        <p className="text-[11px] font-normal text-brand-400">{t(SALES_CHANNEL_LABEL_KEY[order.sales_channel])}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-brand-700">
                      <p className="font-medium text-brand-800">{order.contact?.full_name ?? '-'}</p>
                      {order.contact?.phone && <p className="text-[11px] font-normal text-brand-400">{formatClientPhoneDisplay(order.contact.phone_prefix, order.contact.phone)}</p>}
                      {order.opportunity && <p className="text-[11px] font-normal text-brand-400">{order.opportunity.title}</p>}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <StatusDotLine
                          label={t('orders.table.deliveryStateLabel')}
                          dotClass={ORDER_STATUS_DOT_CLASS[order.status]}
                          value={t(ORDER_STATUS_LABEL_KEY[order.status])}
                        />
                        {/* Un pedido de mostrador no tiene envío: la línea
                            entera se omite en vez de mostrar un estado que
                            no significa nada (mismo criterio que el detalle,
                            ver showShipping en OrderDetail.tsx). */}
                        {order.sales_channel !== 'pos' && (
                          <StatusDotLine
                            label={t('orders.table.shippingStateLabel')}
                            dotClass={order.status === 'confirmada' ? DELIVERY_STATUS_DOT_CLASS[order.delivery_status] : null}
                            value={order.status === 'confirmada' ? t(DELIVERY_STATUS_LABEL_KEY[order.delivery_status]) : '—'}
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-brand-700">
                      {order.sales_channel === 'pos' ? (
                        <span className="text-brand-300">—</span>
                      ) : order.shipping_address ? (
                        <>
                          <p>{order.shipping_address.line1}</p>
                          {(order.shipping_address.city || order.shipping_address.state_province) && (
                            <p className="text-[11px] text-brand-400">
                              {[order.shipping_address.city, order.shipping_address.state_province].filter(Boolean).join(', ')}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-brand-300">{t('orders.table.noAddress')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <OrderPaymentMethodCell methods={paymentsByOrder.get(order.id)} />
                    </TableCell>
                    <TableCell className="text-xs text-brand-700">
                      <p>{formatCurrency(order.total, order.currency)}</p>
                      {order.items?.[0]?.count > 0 && (
                        <p className="text-[11px] text-brand-400">
                          {t(order.items[0].count === 1 ? 'orders.table.itemsCount.singular' : 'orders.table.itemsCount.plural', { count: order.items[0].count })}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-brand-500">
                      <p>{formatDate(order.created_at)}</p>
                      <p className="text-[11px] text-brand-400">{formatTime(order.created_at, language)}</p>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" aria-label={t('orders.table.actions')}>
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onSelect={() => navigate(`/app/sales/${order.id}`)}>{t('orders.actions.viewDetail')}</DropdownMenuItem>
                          {order.status === 'cotizacion' && (
                            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOrder(order)}>
                              {t('orders.actions.cancelQuote')}
                            </DropdownMenuItem>
                          )}
                          {order.status === 'confirmada' && (
                            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOrder(order)}>
                              {t('orders.actions.voidSale')}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} alwaysVisible />
        </>
      )}

      <ConfirmDialog
        open={!!confirmOrder}
        onClose={() => {
          if (confirming) return
          setConfirmOrder(null)
          setConfirmError(null)
        }}
        onConfirm={() => {
          if (!confirmOrder) return
          if (confirmOrder.status === 'cotizacion') handleCancelQuote(confirmOrder.id)
          else handleVoid(confirmOrder.id)
        }}
        title={confirmOrder?.status === 'cotizacion' ? t('orders.actions.cancelQuote') : t('orders.actions.voidSale')}
        description={confirmOrder?.status === 'cotizacion' ? t('orders.detail.deleteBody') : t('orders.detail.voidBody')}
        loading={confirming}
        error={confirmError}
      />
    </div>
  )
}
