import { useEffect, useState } from 'react'
import { MoreHorizontalIcon } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { deleteWarehouse, listWarehouses } from '../../lib/api/warehouses'
import type { Warehouse } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Card, CardSection, EmptyState, Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { PlusIcon } from '@/components/atoms/icons'
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

/** "Bodegas" category -- mismo listado/CRUD de siempre, reempaquetado como
 * su propio panel (título + cantidad + acción "Nueva bodega" en el
 * encabezado) y con un único menú de tres puntos por fila en vez de los
 * botones de editar/eliminar separados -- mismo componente DropdownMenu ya
 * usado en Orders.tsx/ProductDetail.tsx/ClientDetail.tsx, y el borrado pasa
 * a un ConfirmDialog real (mismo patrón que DispatchStatusesSection/
 * ReturnStatusesSection/PosPointsSection) en vez de un Confirmar/Cancelar
 * inline en la celda. */
export function Warehouses() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; warehouse: Warehouse | null }>({ open: false, warehouse: null })
  const [warehouseToDelete, setWarehouseToDelete] = useState<Warehouse | null>(null)
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

  async function handleConfirmDelete() {
    if (!warehouseToDelete) return
    setDeleting(true)
    setError(null)
    try {
      await deleteWarehouse(warehouseToDelete.id)
      setWarehouses((prev) => (prev ? prev.filter((w) => w.id !== warehouseToDelete.id) : prev))
      setWarehouseToDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.warehouses.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card padded={false}>
      <CardSection
        title={
          <span className="inline-flex items-center gap-2">
            {t('inventory.warehouses.title')}
            <span className="text-xs font-normal text-brand-400">
              ({warehouses?.length ?? 0} {t((warehouses?.length ?? 0) === 1 ? 'inventory.warehouses.count.singular' : 'inventory.warehouses.count.plural')})
            </span>
          </span>
        }
        action={
          <Button size="sm" onClick={() => setDrawer({ open: true, warehouse: null })}>
            <PlusIcon width={14} height={14} /> {t('inventory.warehouses.actions.new')}
          </Button>
        }
      >
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!warehouses && !error && <PageSpinner />}

        {warehouses && warehouses.length === 0 && <EmptyState>{t('inventory.warehouses.empty')}</EmptyState>}

        {pageItems && pageItems.length > 0 && (
          <>
            <div className="overflow-hidden rounded-xl border border-brand-100 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('inventory.warehouses.table.name')}</TableHead>
                    <TableHead>{t('inventory.warehouses.table.address')}</TableHead>
                    <TableHead>{t('inventory.warehouses.table.city')}</TableHead>
                    <TableHead>{t('inventory.warehouses.table.type')}</TableHead>
                    <TableHead>{t('inventory.warehouses.table.status')}</TableHead>
                    <TableHead className="w-10" />
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs" aria-label={t('inventory.warehouses.table.actions')}>
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setDrawer({ open: true, warehouse })}>{t('common.actions.edit')}</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setWarehouseToDelete(warehouse)}>
                              {t('common.actions.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-3">
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </div>
          </>
        )}

        {profile?.tenant_id && (
          <WarehouseDrawer open={drawer.open} onClose={() => setDrawer({ open: false, warehouse: null })} tenantId={profile.tenant_id} warehouse={drawer.warehouse} onSaved={reload} />
        )}

        <ConfirmDialog
          open={!!warehouseToDelete}
          onClose={() => setWarehouseToDelete(null)}
          onConfirm={handleConfirmDelete}
          title={t('inventory.warehouses.deleteConfirm.title')}
          description={t('inventory.warehouses.deleteConfirm.description', { name: warehouseToDelete?.name ?? '' })}
          loading={deleting}
        />
      </CardSection>
    </Card>
  )
}
