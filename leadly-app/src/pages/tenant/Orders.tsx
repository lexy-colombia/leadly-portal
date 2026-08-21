import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontalIcon } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useHeaderSearchSlot } from '@/contexts/HeaderSearchSlotContext'
import type { TranslationKey } from '../../i18n/translations'
import { formatDate } from '../../lib/dates'
import { deleteOrder, listOrders, updateOrderStatus, ORDER_STATUS_LABEL_KEY, ORDER_STATUS_BADGE_CLASS, DELIVERY_STATUS_LABEL_KEY, DELIVERY_STATUS_BADGE_CLASS } from '../../lib/api/orders'
import type { OrderWithRelations } from '../../lib/api/orders'
import { listClients } from '../../lib/api/clients'
import type { Client, OrderStatus } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card, ComboboxFilter, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { PlusIcon, SearchIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const PAGE_SIZE = 10

// Same trigger sizing convention as Products.tsx/Clients.tsx's filter
// pills, so this list doesn't feel like a separate design system.
const FILTER_TRIGGER_CLASS = 'w-40 rounded-lg text-xs'

type Period = 'all' | 'today' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'custom'

const PERIOD_LABEL_KEY: Record<Period, TranslationKey> = {
  all: 'orders.filters.period.all',
  today: 'orders.filters.period.today',
  '7d': 'orders.filters.period.7d',
  '30d': 'orders.filters.period.30d',
  thisMonth: 'orders.filters.period.thisMonth',
  lastMonth: 'orders.filters.period.lastMonth',
  custom: 'orders.filters.period.custom',
}

/** [start, end) for a period preset -- end is exclusive so "hasta" (custom)
 * can be expressed as "start of the next day" without a >= vs > mismatch.
 * A null bound means "no limit on that side" (today/7d/30d/thisMonth all
 * run through the present moment). */
function resolvePeriodRange(period: Period, dateFrom: string, dateTo: string): { start: Date | null; end: Date | null } {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (period) {
    case 'all':
      return { start: null, end: null }
    case 'today':
      return { start: startOfToday, end: null }
    case '7d': {
      const start = new Date(startOfToday)
      start.setDate(start.getDate() - 6)
      return { start, end: null }
    }
    case '30d': {
      const start = new Date(startOfToday)
      start.setDate(start.getDate() - 29)
      return { start, end: null }
    }
    case 'thisMonth':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null }
    case 'lastMonth':
      return { start: new Date(now.getFullYear(), now.getMonth() - 1, 1), end: new Date(now.getFullYear(), now.getMonth(), 1) }
    case 'custom': {
      const start = dateFrom ? new Date(`${dateFrom}T00:00:00`) : null
      const end = dateTo ? new Date(new Date(`${dateTo}T00:00:00`).getTime() + 24 * 60 * 60 * 1000) : null
      return { start, end }
    }
    default:
      return { start: null, end: null }
  }
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

export function Orders() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { slot: headerSearchSlot } = useHeaderSearchSlot()

  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [contacts, setContacts] = useState<Client[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<OrderStatus | null>(null)
  const [contactFilter, setContactFilter] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
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
  }, [profile?.tenant_id])

  const { start: periodStart, end: periodEnd } = useMemo(() => resolvePeriodRange(period, dateFrom, dateTo), [period, dateFrom, dateTo])

  const filtered = useMemo(() => {
    if (!orders) return null
    const term = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false
      if (contactFilter && o.contact_id !== contactFilter) return false
      const createdAt = new Date(o.created_at)
      if (periodStart && createdAt < periodStart) return false
      if (periodEnd && createdAt >= periodEnd) return false
      if (!term) return true
      return `ord-${o.number}`.includes(term) || (o.contact?.full_name ?? '').toLowerCase().includes(term)
    })
  }, [orders, statusFilter, contactFilter, periodStart, periodEnd, search])

  useEffect(() => {
    setPage(1)
    setSelectedIds(new Set())
  }, [statusFilter, contactFilter, period, dateFrom, dateTo, search])

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

      <div className="flex flex-wrap items-center gap-2">
        <ComboboxFilter
          options={(Object.keys(ORDER_STATUS_LABEL_KEY) as OrderStatus[]).map((s) => ({ id: s, label: t(ORDER_STATUS_LABEL_KEY[s]) }))}
          value={statusFilter}
          onChange={(id) => setStatusFilter(id as OrderStatus | null)}
          placeholder={t('orders.filters.all')}
          searchPlaceholder={t('orders.filters.search')}
          emptyLabel={t('orders.filters.noResults')}
          triggerClassName={FILTER_TRIGGER_CLASS}
        />

        <ComboboxFilter
          options={contacts.map((c) => ({ id: c.id, label: c.full_name }))}
          value={contactFilter}
          onChange={setContactFilter}
          placeholder={t('orders.filters.allContacts')}
          searchPlaceholder={t('orders.filters.searchContact')}
          emptyLabel={t('orders.filters.noResults')}
          triggerClassName={FILTER_TRIGGER_CLASS}
        />

        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger size="sm" className={FILTER_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PERIOD_LABEL_KEY) as Period[]).map((p) => (
              <SelectItem key={p} value={p}>
                {t(PERIOD_LABEL_KEY[p])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {period === 'custom' && (
          <>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label={t('orders.filters.dateFrom')} className="h-7 w-36 rounded-lg text-xs" />
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label={t('orders.filters.dateTo')} className="h-7 w-36 rounded-lg text-xs" />
          </>
        )}

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {t((filtered?.length ?? 0) === 1 ? 'orders.count.singular' : 'orders.count.plural')}
        </span>

        <Button onClick={() => navigate('/app/sales/new')} size="sm" className="ml-auto">
          <PlusIcon width={14} height={14} /> {t('orders.actions.newSale')}
        </Button>
      </div>

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
                    <TableCell className="text-xs font-medium text-brand-800">ORD-{order.number}</TableCell>
                    <TableCell className="text-xs text-brand-700">
                      {order.contact?.full_name ?? '-'}
                      {order.opportunity && <span className="block text-[11px] font-normal text-brand-400">{order.opportunity.title}</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={ORDER_STATUS_BADGE_CLASS[order.status]}>
                        {t(ORDER_STATUS_LABEL_KEY[order.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {order.status === 'confirmada' ? (
                        <Badge variant="outline" className={DELIVERY_STATUS_BADGE_CLASS[order.delivery_status]}>
                          {t(DELIVERY_STATUS_LABEL_KEY[order.delivery_status])}
                        </Badge>
                      ) : (
                        <span className="text-xs text-brand-300">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-brand-700">{formatCurrency(order.total, order.currency)}</TableCell>
                    <TableCell className="text-xs text-brand-500">{formatDate(order.created_at)}</TableCell>
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
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
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
