import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, usePermission } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../contexts/ToastContext'
import { useResetOnFilterChange, useUrlFilterSync } from '../../lib/urlFilters'
import { deleteMaterial, formatQuantity, listMaterialsPage, type MaterialOverviewRow } from '../../lib/api/materials'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { ArchiveIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MaterialDrawer } from './materials/MaterialDrawer'
import { MaterialStockDrawer } from './materials/MaterialStockDrawer'

const PAGE_SIZE = 10

function formatCurrency(value: number, language: 'es' | 'en'): string {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(value)
}

/** Módulo "Insumos": materias primas que alimentan la ficha técnica de los
 * productos "se arma con insumos". Listado paginado server-side vía
 * `get_materials_overview`; total/reservado/disponible los calcula el
 * backend, esta pantalla solo los muestra. */
export function Materials() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const toast = useToast()
  const tenantId = profile?.tenant_id
  const canCreate = usePermission('materials.create')
  const canEdit = usePermission('materials.edit')
  const canDelete = usePermission('materials.delete')

  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '')
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get('q') ?? '')
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1))
  const [rows, setRows] = useState<MaterialOverviewRow[] | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ open: boolean; material: MaterialOverviewRow | null }>({ open: false, material: null })
  const [stockFor, setStockFor] = useState<MaterialOverviewRow | null>(null)
  const [toDelete, setToDelete] = useState<MaterialOverviewRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const reqRef = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350)
    return () => clearTimeout(timer)
  }, [search])

  useResetOnFilterChange(debouncedSearch, () => setPage(1))
  useUrlFilterSync({ q: debouncedSearch || null, page: page > 1 ? String(page) : null })

  function reload() {
    if (!tenantId) return
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    listMaterialsPage({ search: debouncedSearch, page, pageSize: PAGE_SIZE })
      .then(({ data, count }) => {
        if (reqRef.current !== reqId) return
        // Página más allá del final (se borró lo último de ella): volver a la 1.
        if (data.length === 0 && page > 1) {
          setPage(1)
          return
        }
        setRows(data)
        setTotalCount(count)
        // Mantiene sincronizado el drawer de inventario abierto.
        setStockFor((prev) => (prev ? (data.find((r) => r.id === prev.id) ?? prev) : prev))
      })
      .catch((err) => {
        if (reqRef.current === reqId) setError(err.message ?? t('materials.errors.load'))
      })
      .finally(() => {
        if (reqRef.current === reqId) setLoading(false)
      })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => reload(), [tenantId, page, debouncedSearch])

  async function handleConfirmDelete() {
    if (!toDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteMaterial(toDelete.id)
      setToDelete(null)
      toast.success(t('materials.toast.deleted'))
      reload()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('materials.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  if (!tenantId) return <PageSpinner />

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-brand-100 bg-brand-50/40 p-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('materials.list.searchPlaceholder')}
          aria-label={t('materials.list.searchPlaceholder')}
          className="h-7 w-64 rounded-lg border-brand-300 text-xs"
        />
        {canCreate && (
          <Button size="sm" className="ml-auto" onClick={() => setDrawer({ open: true, material: null })}>
            <PlusIcon width={14} height={14} /> {t('materials.list.actions.new')}
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button type="button" className="underline" onClick={reload}>
            {t('common.actions.retry')}
          </button>
        </div>
      )}
      {loading && !rows && !error && <PageSpinner />}

      {rows && rows.length === 0 && !error && (
        <Card>
          <EmptyState>{debouncedSearch ? t('materials.list.empty.noMatch') : t('materials.list.empty.none')}</EmptyState>
        </Card>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className={`overflow-hidden rounded-2xl border border-brand-100 bg-white transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('materials.list.table.name')}</TableHead>
                  <TableHead>{t('materials.list.table.unit')}</TableHead>
                  <TableHead className="text-right">{t('materials.list.table.total')}</TableHead>
                  <TableHead className="text-right">{t('materials.list.table.reserved')}</TableHead>
                  <TableHead className="text-right">{t('materials.list.table.available')}</TableHead>
                  <TableHead className="text-right">{t('materials.list.table.cost')}</TableHead>
                  <TableHead>{t('materials.list.table.status')}</TableHead>
                  <TableHead className="text-right">{t('materials.list.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => {
                  const low = m.min_stock != null && m.available <= m.min_stock
                  return (
                    <TableRow key={m.id} className="cursor-pointer" onClick={() => navigate(`/app/materials/${m.id}`, { state: { returnTo: location.pathname + location.search } })}>
                      <TableCell className="text-xs font-medium text-brand-800">
                        <Link to={`/app/materials/${m.id}`} state={{ returnTo: location.pathname + location.search }} onClick={(e) => e.stopPropagation()} className="hover:text-accent-700 hover:underline">
                          {m.name}
                        </Link>
                        {m.sku && <span className="ml-1.5 font-normal text-brand-400">{m.sku}</span>}
                      </TableCell>
                      <TableCell className="text-xs text-brand-500">{t(`materials.unit.${m.unit}`)}</TableCell>
                      <TableCell className="text-right text-xs text-brand-700">{formatQuantity(m.total_quantity, language)}</TableCell>
                      <TableCell className="text-right text-xs text-brand-500">{formatQuantity(m.reserved, language)}</TableCell>
                      <TableCell className="text-right text-xs font-semibold text-brand-800">
                        <span className="inline-flex items-center gap-1.5">
                          {formatQuantity(m.available, language)}
                          {low && <Badge variant="destructive">{t('materials.list.lowStock')}</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs text-brand-700">{formatCurrency(m.cost, language)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={m.is_active ? 'border-transparent bg-emerald-50 text-emerald-700' : 'border-transparent bg-brand-50 text-brand-600'}>
                          {t(m.is_active ? 'common.status.active' : 'common.status.inactive')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" title={t('materials.list.actions.inventory')} aria-label={t('materials.list.actions.inventory')} onClick={() => setStockFor(m)}>
                            <ArchiveIcon className="size-3" />
                          </Button>
                          {canEdit && (
                            <Button variant="ghost" size="icon-xs" aria-label={t('common.actions.edit')} onClick={() => setDrawer({ open: true, material: m })}>
                              <PencilIcon width={12} height={12} />
                            </Button>
                          )}
                          {canDelete && (
                            <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" aria-label={t('common.actions.delete')} onClick={() => setToDelete(m)}>
                              <TrashIcon width={12} height={12} />
                            </Button>
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <MaterialDrawer open={drawer.open} onClose={() => setDrawer({ open: false, material: null })} tenantId={tenantId} material={drawer.material} onSaved={reload} />
      <MaterialStockDrawer open={!!stockFor} onClose={() => setStockFor(null)} tenantId={tenantId} material={stockFor} onSaved={reload} />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={handleConfirmDelete}
        title={t('materials.deleteConfirm.title')}
        description={t('materials.deleteConfirm.description', { name: toDelete?.name ?? '' })}
        confirmLabel={t('common.actions.delete')}
        loading={deleting}
        error={deleteError}
      />
    </div>
  )
}
