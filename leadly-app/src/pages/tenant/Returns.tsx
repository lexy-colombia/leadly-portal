import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { listReturns, type ReturnWithOrder } from '../../lib/api/returns'
import { RETURN_REASON_LABEL_KEY } from '../../lib/returnReasons'
import { formatDate } from '../../lib/dates'
import { formatClientPhoneDisplay } from '../../lib/phone'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PlusIcon } from '@/components/atoms/icons'
import { ReturnCreateDrawer } from './returns/ReturnCreateDrawer'
import { ReturnDetailDrawer } from './returns/ReturnDetailDrawer'

const PAGE_SIZE = 10

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Valor de lo reclamado -- cantidad × precio unitario de la línea original
 * de venta, sumado sobre todos los ítems del ticket. Distinto de
 * `resolution_amount` (lo que el tenant decide devolver/acreditar, puede
 * ser menor o quedar sin definir hasta que se resuelve el caso). */
function claimAmount(r: ReturnWithOrder): number {
  return r.items.reduce((sum, item) => sum + item.quantity * (item.sales_order_item?.unit_price ?? 0), 0)
}

function itemCount(r: ReturnWithOrder): number {
  return r.items.reduce((sum, item) => sum + item.quantity, 0)
}

export function Returns() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [returns, setReturns] = useState<ReturnWithOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  function reload() {
    if (!profile?.tenant_id) return
    listReturns(profile.tenant_id)
      .then(setReturns)
      .catch((err) => setError(err instanceof Error ? err.message : t('returns.errors.load')))
  }

  useEffect(reload, [profile?.tenant_id])

  const totalPages = returns ? Math.max(1, Math.ceil(returns.length / PAGE_SIZE)) : 1
  const pageItems = useMemo(() => (returns ? returns.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null), [returns, page])

  if (!profile?.tenant_id) return <PageSpinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-brand-800">{t('returns.title')}</h1>
          <p className="text-sm text-brand-400">{t('returns.description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon width={14} height={14} /> {t('returns.actions.new')}
        </Button>
      </div>

      {returns && (
        <span className="text-xs text-brand-400">
          {returns.length} {t(returns.length === 1 ? 'returns.count.singular' : 'returns.count.plural')}
        </span>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!returns && !error && <PageSpinner />}

      {returns && returns.length === 0 && (
        <Card>
          <EmptyState>{t('returns.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('returns.table.order')}</TableHead>
                  <TableHead>{t('returns.table.client')}</TableHead>
                  <TableHead>{t('returns.table.reason')}</TableHead>
                  <TableHead>{t('returns.table.status')}</TableHead>
                  <TableHead>{t('returns.table.claimAmount')}</TableHead>
                  <TableHead>{t('returns.table.resolution')}</TableHead>
                  <TableHead className="text-right">{t('returns.table.date')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((r) => {
                  const currency = r.sales_order?.currency ?? 'COP'
                  const amount = claimAmount(r)
                  const count = itemCount(r)
                  return (
                    <TableRow key={r.id} onClick={() => setSelectedId(r.id)} className="cursor-pointer">
                      <TableCell className="text-xs font-medium text-brand-800">{r.sales_order ? `#${r.sales_order.number}` : '—'}</TableCell>
                      <TableCell className="text-xs text-brand-700">
                        <p className="font-medium text-brand-800">{r.sales_order?.contact?.full_name ?? '—'}</p>
                        {r.sales_order?.contact?.phone && <p className="text-[11px] font-normal text-brand-400">{formatClientPhoneDisplay(r.sales_order.contact.phone_prefix, r.sales_order.contact.phone)}</p>}
                      </TableCell>
                      <TableCell className="text-xs text-brand-600">{t(RETURN_REASON_LABEL_KEY[r.reason])}</TableCell>
                      <TableCell>
                        {r.status && (
                          <Badge variant="outline" className="border-transparent" style={{ backgroundColor: `${r.status.color}1A`, color: r.status.color }}>
                            {r.status.name}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-brand-700">
                        <p className="font-medium">{formatCurrency(amount, currency)}</p>
                        {count > 0 && (
                          <p className="text-[11px] text-brand-400">{t(count === 1 ? 'returns.table.itemsCount.singular' : 'returns.table.itemsCount.plural', { count })}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-brand-700">
                        {r.resolution_type ? (
                          <>
                            <p className="flex items-center gap-1.5">
                              {r.credit_granted && <span className="inline-block size-1.5 shrink-0 rounded-full bg-emerald-500" />}
                              {r.resolution_type.name}
                            </p>
                            {r.resolution_amount != null && <p className="text-[11px] text-brand-400">{formatCurrency(r.resolution_amount, currency)}</p>}
                          </>
                        ) : (
                          <span className="text-brand-300">{t('returns.table.resolutionPending')}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-brand-500">{formatDate(r.created_at)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <ReturnCreateDrawer open={createOpen} onClose={() => setCreateOpen(false)} tenantId={profile.tenant_id} onCreated={() => reload()} />
      {selectedId && <ReturnDetailDrawer open={!!selectedId} onClose={() => setSelectedId(null)} returnId={selectedId} tenantId={profile.tenant_id} />}
    </div>
  )
}
