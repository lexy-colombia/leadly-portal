import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { deleteWarehouse, listWarehouses } from '../../lib/api/warehouses'
import type { Warehouse } from '../../types/domain'
import { Badge, Button, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { WarehouseDrawer } from './inventory/WarehouseDrawer'

const PAGE_SIZE = 10

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
        <Button variant="secondary" onClick={() => setDrawer({ open: true, warehouse: null })} className="!py-1 !text-xs">
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
          <Table>
            <THead>
              <tr>
                <TH>{t('inventory.warehouses.table.name')}</TH>
                <TH>{t('inventory.warehouses.table.address')}</TH>
                <TH>{t('inventory.warehouses.table.city')}</TH>
                <TH>{t('inventory.warehouses.table.type')}</TH>
                <TH>{t('inventory.warehouses.table.status')}</TH>
                <TH className="text-right">{t('inventory.warehouses.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((warehouse) => (
                <TRow key={warehouse.id}>
                  <TD className="text-xs font-medium text-brand-800">
                    <span className="inline-flex items-center gap-2">
                      {warehouse.name}
                      {warehouse.is_default && <Badge tone="neutral">{t('inventory.warehouses.badge.default')}</Badge>}
                    </span>
                  </TD>
                  <TD className="text-xs text-brand-500">{warehouse.address ?? '-'}</TD>
                  <TD className="text-xs text-brand-500">{warehouse.city ?? '-'}</TD>
                  <TD className="text-xs text-brand-500">{t(`inventory.warehouseType.${warehouse.type}`)}</TD>
                  <TD>
                    <Badge tone={warehouse.is_active ? 'success' : 'neutral'}>{t(warehouse.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                  </TD>
                  <TD className="text-right">
                    {deletingId === warehouse.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(warehouse.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {t('common.actions.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, warehouse })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(warehouse.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                          <TrashIcon width={12} height={12} />
                        </Button>
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
        <WarehouseDrawer open={drawer.open} onClose={() => setDrawer({ open: false, warehouse: null })} tenantId={profile.tenant_id} warehouse={drawer.warehouse} onSaved={reload} />
      )}
    </div>
  )
}
