import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { deleteOrder, listOrders, updateOrderStatus } from '../../lib/api/orders'
import type { OrderWithRelations } from '../../lib/api/orders'
import type { OrderStatus } from '../../types/domain'
import { Badge, Button, Card, EmptyState, PageSpinner, Pagination, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { PencilIcon, PlusIcon, TrashIcon } from '../../components/icons'
import { OrderDrawer } from './orders/OrderDrawer'

const PAGE_SIZE = 10

const STATUS_LABEL: Record<OrderStatus, string> = {
  cotizacion: 'Cotización',
  confirmada: 'Confirmada',
  en_proceso: 'En proceso',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
}

const STATUS_TONE: Record<OrderStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  cotizacion: 'neutral',
  confirmada: 'warning',
  en_proceso: 'warning',
  entregada: 'success',
  cancelada: 'danger',
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

export function Ventas() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; order: OrderWithRelations | null }>({ open: false, order: null })
  // Shared by both destructive actions (cancel a cotización / anular a
  // venta) -- only one of the two is ever offered per row (see the status
  // check in the actions column), so one pending-id is enough.
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  function reload() {
    if (!profile?.tenant_id) return
    listOrders(profile.tenant_id)
      .then(setOrders)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar las cotizaciones/ventas.'))
  }

  useEffect(reload, [profile?.tenant_id])

  const filtered = useMemo(() => {
    if (!orders) return null
    if (statusFilter === 'all') return orders
    return orders.filter((o) => o.status === statusFilter)
  }, [orders, statusFilter])

  useEffect(() => {
    setPage(1)
  }, [statusFilter])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleConfirm(id: string) {
    setConfirmingId(id)
    setError(null)
    try {
      await updateOrderStatus(id, 'confirmada')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo confirmar la venta.')
    } finally {
      setConfirmingId(null)
    }
  }

  /** Only reachable while status === 'cotizacion' (see actions column) --
   * cancels it and removes it from view. A confirmed venta can never take
   * this path; see handleVoid. */
  async function handleCancelQuote(id: string) {
    setPending(true)
    setError(null)
    try {
      await deleteOrder(id)
      setOrders((prev) => (prev ? prev.filter((o) => o.id !== id) : prev))
      setPendingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cancelar la cotización.')
    } finally {
      setPending(false)
    }
  }

  /** A venta (confirmada/en_proceso/entregada) can't be deleted, only
   * anulada -- status moves to 'cancelada' (the stock-effect trigger
   * restores the deducted stock) but the row stays visible, never soft-
   * deleted, since a sale is a permanent record. */
  async function handleVoid(id: string) {
    setPending(true)
    setError(null)
    try {
      await updateOrderStatus(id, 'cancelada')
      reload()
      setPendingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo anular la venta.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(['all', ...Object.keys(STATUS_LABEL)] as (OrderStatus | 'all')[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                statusFilter === s ? 'border-accent-400 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-500 hover:bg-brand-50'
              }`}
            >
              {s === 'all' ? 'Todas' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {(filtered?.length ?? 0) === 1 ? 'resultado' : 'resultados'}
        </span>

        <Button variant="secondary" onClick={() => setDrawer({ open: true, order: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> Nueva cotización
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!orders && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>{orders && orders.length > 0 ? 'Ninguna coincide con el filtro.' : 'Todavía no tenés cotizaciones ni ventas.'}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <TH>N°</TH>
                <TH>Contacto</TH>
                <TH>Estado</TH>
                <TH>Total</TH>
                <TH>Fecha</TH>
                <TH className="text-right">Acciones</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((order) => (
                <TRow key={order.id}>
                  <TD className="cursor-pointer text-xs font-medium text-brand-800" onClick={() => navigate(`/app/ventas/${order.id}`)}>
                    ORD-{order.number}
                  </TD>
                  <TD className="cursor-pointer text-xs text-brand-700" onClick={() => navigate(`/app/ventas/${order.id}`)}>
                    {order.contact?.full_name ?? '-'}
                    {order.opportunity && <span className="block text-[11px] font-normal text-brand-400">{order.opportunity.title}</span>}
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Badge>
                  </TD>
                  <TD className="text-xs text-brand-700">{formatCurrency(order.total, order.currency)}</TD>
                  <TD className="text-xs text-brand-500">{new Date(order.created_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}</TD>
                  <TD className="text-right">
                    {pendingId === order.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button
                          variant="danger"
                          onClick={() => (order.status === 'cotizacion' ? handleCancelQuote(order.id) : handleVoid(order.id))}
                          disabled={pending}
                          className="!px-2 !py-1 text-xs"
                        >
                          {pending ? 'Procesando…' : order.status === 'cotizacion' ? 'Cancelar cotización' : 'Anular venta'}
                        </Button>
                        <Button variant="ghost" onClick={() => setPendingId(null)} disabled={pending} className="!px-2 !py-1 text-xs">
                          Volver
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        {order.status === 'cotizacion' && (
                          <Button variant="ghost" onClick={() => handleConfirm(order.id)} disabled={confirmingId === order.id} className="!px-2 !py-1 text-xs !text-accent-700">
                            {confirmingId === order.id ? 'Confirmando…' : 'Convertir en venta'}
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, order })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        {order.status === 'cotizacion' && (
                          <Button variant="ghost" onClick={() => setPendingId(order.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                            <TrashIcon width={12} height={12} />
                          </Button>
                        )}
                        {(order.status === 'confirmada' || order.status === 'en_proceso' || order.status === 'entregada') && (
                          <Button variant="ghost" onClick={() => setPendingId(order.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                            Anular
                          </Button>
                        )}
                      </span>
                    )}
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      {profile?.tenant_id && (
        <OrderDrawer open={drawer.open} onClose={() => setDrawer({ open: false, order: null })} tenantId={profile.tenant_id} order={drawer.order} onSaved={reload} />
      )}
    </div>
  )
}
