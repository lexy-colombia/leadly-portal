import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { deleteWarehouse, listWarehouses } from '../../lib/api/warehouses'
import type { Warehouse } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { WarehouseDrawer } from './inventory/WarehouseDrawer'

const PAGE_SIZE = 10

// bg/text pair on top of shadcn Badge's `outline` variant -- mismo criterio
// que STAGE_BADGE_CLASS en Clients.tsx, ninguno de los tonos de fábrica de
// shadcn (default/secondary/destructive/outline/ghost) cubre "neutral"/"success".
const WAREHOUSE_STATUS_BADGE_CLASS: Record<'active' | 'inactive', string> = {
  active: 'border-transparent bg-emerald-50 text-emerald-700',
  inactive: 'border-transparent bg-brand-50 text-brand-600',
}
const WAREHOUSE_DEFAULT_BADGE_CLASS = 'border-transparent bg-brand-50 text-brand-600'

export function Warehouses() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; warehouse: Warehouse | null }>({ open: false, warehouse: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    if (!profile?.tenant_id) return
    listWarehouses(profile.tenant_id)
      .then(setWarehouses)
      .catch((err) => setError(err.message ?? t('inventory.warehouses.errors.load')))
  }

  useEffect(reload, [profile?.tenant_id])

  const totalPages = warehouses ? Math.max(1, Math.ceil(warehouses.length / PAGE_SIZE)) : 1
  const pageItems = warehouses ? warehouses.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteWarehouse(id)
      setWarehouses((prev) => (prev ? prev.filter((w) => w.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.warehouses.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-brand-400">
          {warehouses?.length ?? 0} {t((warehouses?.length ?? 0) === 1 ? 'inventory.warehouses.count.singular' : 'inventory.warehouses.count.plural')}
        </span>
        <Button variant="secondary" size="sm" onClick={() => setDrawer({ open: true, warehouse: null })}>
          <PlusIcon width={14} height={14} /> {t('inventory.warehouses.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!warehouses && !error && <PageSpinner />}

      {warehouses && warehouses.length === 0 && (
        <Card>
          <EmptyState>{t('inventory.warehouses.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('inventory.warehouses.table.name')}</TableHead>
                  <TableHead>{t('inventory.warehouses.table.address')}</TableHead>
                  <TableHead>{t('inventory.warehouses.table.city')}</TableHead>
                  <TableHead>{t('inventory.warehouses.table.type')}</TableHead>
                  <TableHead>{t('inventory.warehouses.table.status')}</TableHead>
                  <TableHead className="text-right">{t('inventory.warehouses.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((warehouse) => (
                  <TableRow key={warehouse.id} onClick={() => setDrawer({ open: true, warehouse })} className="cursor-pointer">
                    <TableCell className="text-xs font-medium text-brand-800">
                      <span className="inline-flex items-center gap-2">
                        {warehouse.name}
                        {warehouse.is_default && (
                          <Badge variant="outline" className={WAREHOUSE_DEFAULT_BADGE_CLASS}>
                            {t('inventory.warehouses.badge.default')}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-brand-500">{warehouse.address ?? '-'}</TableCell>
                    <TableCell className="text-xs text-brand-500">{warehouse.city ?? '-'}</TableCell>
                    <TableCell className="text-xs text-brand-500">{t(`inventory.warehouseType.${warehouse.type}`)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={WAREHOUSE_STATUS_BADGE_CLASS[warehouse.is_active ? 'active' : 'inactive']}>
                        {t(warehouse.is_active ? 'common.status.active' : 'common.status.inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {deletingId === warehouse.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="destructive" size="xs" onClick={() => handleDelete(warehouse.id)} disabled={deleting}>
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, warehouse })}>
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setDeletingId(warehouse.id)}>
                            <TrashIcon width={12} height={12} />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      {profile?.tenant_id && (
        <WarehouseDrawer open={drawer.open} onClose={() => setDrawer({ open: false, warehouse: null })} tenantId={profile.tenant_id} warehouse={drawer.warehouse} onSaved={reload} />
      )}
    </div>
  )
}
