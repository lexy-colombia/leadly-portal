import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { usePermission, useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { formatDateTime } from '../../lib/dates'
import { useResetOnFilterChange, useUrlFilterSync, getListReturnUrl } from '../../lib/urlFilters'
import {
  formatQuantity,
  getMaterial,
  getMaterialOverview,
  isMaterialEntry,
  listMaterialMovementsPage,
  listMaterialStock,
  listMaterialUsagePage,
  MATERIAL_MOVEMENT_TYPE_KEY,
  type MaterialMovementWithWarehouse,
  type MaterialOverviewRow,
  type MaterialStockWithWarehouse,
  type MaterialUsageLine,
} from '../../lib/api/materials'
import type { Material, MaterialMovementType } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { PencilIcon } from '@/components/atoms/icons'
import { Pagination } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ArchiveIcon } from 'lucide-react'
import { MaterialDrawer } from './materials/MaterialDrawer'
import { MaterialStockDrawer } from './materials/MaterialStockDrawer'

const MOVEMENTS_PAGE_SIZE = 20
const USAGE_PAGE_SIZE = 10
const ALL = 'all'
const MOVEMENT_TYPES: MaterialMovementType[] = ['carga_inicial', 'entrada', 'salida', 'ajuste_positivo', 'ajuste_negativo']

function StatCard({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-brand-100 p-4 ${className}`}>
      <h3 className="mb-2.5 text-xs font-semibold text-brand-800">{title}</h3>
      {children}
    </div>
  )
}

function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useLanguage()
  return (
    <p className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
      {message}
      <button type="button" className="underline" onClick={onRetry}>
        {t('common.actions.retry')}
      </button>
    </p>
  )
}

function formatCurrency(value: number, language: 'es' | 'en'): string {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(value)
}

/** Detalle de UN insumo: totales (los calcula el backend), existencias por
 * bodega, kardex completo con filtros y las fichas técnicas que lo usan. */
export function MaterialDetail() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const listReturnUrl = getListReturnUrl('/app/materials', location.state)
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const tenantId = profile?.tenant_id
  const canEdit = usePermission('materials.edit')
  const canAdjust = usePermission('materials.adjust_stock')
  const [searchParams] = useSearchParams()

  const [material, setMaterial] = useState<Material | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [overview, setOverview] = useState<MaterialOverviewRow | null>(null)
  const [overviewError, setOverviewError] = useState(false)
  const [stock, setStock] = useState<MaterialStockWithWarehouse[] | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)

  const [typeFilter, setTypeFilter] = useState(() => {
    const v = searchParams.get('type')
    return MOVEMENT_TYPES.includes(v as MaterialMovementType) ? (v as string) : ALL
  })
  const [dateFrom, setDateFrom] = useState(() => searchParams.get('from') ?? '')
  const [dateTo, setDateTo] = useState(() => searchParams.get('to') ?? '')
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1))
  const [movements, setMovements] = useState<MaterialMovementWithWarehouse[] | null>(null)
  const [movementsCount, setMovementsCount] = useState(0)
  const [movementsError, setMovementsError] = useState<string | null>(null)
  const [movementsLoading, setMovementsLoading] = useState(false)
  const movementsReqRef = useRef(0)

  const [usagePage, setUsagePage] = useState(1)
  const [usage, setUsage] = useState<MaterialUsageLine[] | null>(null)
  const [usageCount, setUsageCount] = useState(0)
  const [usageError, setUsageError] = useState<string | null>(null)
  const usageReqRef = useRef(0)

  const filterKey = `${typeFilter}|${dateFrom}|${dateTo}`
  useResetOnFilterChange(filterKey, () => setPage(1))
  useUrlFilterSync({
    type: typeFilter !== ALL ? typeFilter : null,
    from: dateFrom || null,
    to: dateTo || null,
    page: page > 1 ? String(page) : null,
  })

  function loadMaterial() {
    if (!id) return
    setLoadError(null)
    getMaterial(id)
      .then((m) => {
        setMaterial(m)
        if (m) loadOverview(m)
      })
      .catch((err) => setLoadError(err.message ?? t('materials.detail.errors.load')))
  }

  function loadOverview(m: Pick<Material, 'id' | 'name'>) {
    setOverviewError(false)
    getMaterialOverview(m)
      .then((row) => {
        setOverview(row)
        if (!row) setOverviewError(true)
      })
      .catch(() => setOverviewError(true))
  }

  function loadStock() {
    if (!id) return
    setStockError(null)
    listMaterialStock(id)
      .then(setStock)
      .catch((err) => setStockError(err.message ?? t('materials.stock.errors.load')))
  }

  function loadMovements() {
    if (!id) return
    const reqId = ++movementsReqRef.current
    setMovementsError(null)
    setMovementsLoading(true)
    listMaterialMovementsPage(id, page, MOVEMENTS_PAGE_SIZE, {
      type: typeFilter === ALL ? null : (typeFilter as MaterialMovementType),
      from: dateFrom || null,
      to: dateTo || null,
    })
      .then(({ data, count }) => {
        if (movementsReqRef.current !== reqId) return
        if (data.length === 0 && page > 1) {
          setPage(1)
          return
        }
        setMovements(data)
        setMovementsCount(count)
      })
      .catch((err) => {
        if (movementsReqRef.current === reqId) setMovementsError(err.message ?? t('materials.stock.errors.loadMovements'))
      })
      .finally(() => {
        if (movementsReqRef.current === reqId) setMovementsLoading(false)
      })
  }

  function loadUsage() {
    if (!id) return
    const reqId = ++usageReqRef.current
    setUsageError(null)
    listMaterialUsagePage(id, usagePage, USAGE_PAGE_SIZE)
      .then(({ data, count }) => {
        if (usageReqRef.current !== reqId) return
        setUsage(data)
        setUsageCount(count)
      })
      .catch((err) => {
        if (usageReqRef.current === reqId) setUsageError(err.message ?? t('materials.detail.usage.error'))
      })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadMaterial, [id])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadStock, [id])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadMovements, [id, page, typeFilter, dateFrom, dateTo])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadUsage, [id, usagePage])

  /** Tras editar o ajustar: refresca todo lo que puede haber cambiado. */
  function reloadAll() {
    loadMaterial()
    loadStock()
    if (page === 1) loadMovements()
    else setPage(1)
  }

  if (loadError) return <ErrorLine message={loadError} onRetry={loadMaterial} />
  if (material === undefined || !tenantId) return <PageSpinner />
  if (material === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">{t('materials.detail.notFound')}</p>
        <Link to={listReturnUrl} className="text-xs font-medium text-accent-600 hover:text-accent-700">
          {t('materials.detail.backToList')}
        </Link>
      </div>
    )
  }

  const unitLabel = t(`materials.unit.${material.unit}`)
  const low = overview != null && material.min_stock != null && overview.available <= material.min_stock
  const movementsPages = Math.max(1, Math.ceil(movementsCount / MOVEMENTS_PAGE_SIZE))
  const usagePages = Math.max(1, Math.ceil(usageCount / USAGE_PAGE_SIZE))
  const hasFilters = typeFilter !== ALL || !!dateFrom || !!dateTo

  return (
    // El botón "volver" lo resuelve AppShell para toda ruta de detalle.
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xs font-bold text-brand-800">{material.name}</h1>
            <Badge variant={material.is_active ? 'secondary' : 'outline'}>{t(material.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
            {low && <Badge variant="destructive">{t('materials.list.lowStock')}</Badge>}
          </div>
          <p className="text-xs text-brand-500">
            {unitLabel}
            {material.sku && <span className="ml-2 text-brand-400">{material.sku}</span>}
            <span className="ml-3">
              {t('materials.detail.cost')}: {formatCurrency(material.cost, language)}
            </span>
            {material.min_stock != null && (
              <span className="ml-3">
                {t('materials.detail.minStock')}: {formatQuantity(material.min_stock, language)}
              </span>
            )}
          </p>
          {material.notes && <p className="text-xs text-brand-600">{material.notes}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canAdjust && (
            <Button variant="outline" size="sm" onClick={() => setAdjustOpen(true)}>
              <ArchiveIcon className="size-3.5" /> {t('materials.detail.actions.adjust')}
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <PencilIcon width={13} height={13} /> {t('common.actions.edit')}
            </Button>
          )}
        </div>
      </div>

      <StatCard title={t('materials.detail.sections.stock')}>
        {overviewError ? (
          <ErrorLine message={t('materials.detail.errors.overview')} onRetry={() => loadOverview(material)} />
        ) : !overview ? (
          <PageSpinner />
        ) : (
          <div className="grid grid-cols-3 gap-3 text-xs">
            {(
              [
                ['total', overview.total_quantity],
                ['reserved', overview.reserved],
                ['available', overview.available],
              ] as const
            ).map(([key, value]) => (
              <div key={key}>
                <p className="text-brand-500">{t(`materials.detail.stock.${key}`)}</p>
                <p className={`text-sm ${key === 'available' ? 'font-bold text-brand-800' : 'font-semibold text-brand-700'}`}>
                  {formatQuantity(value, language)} <span className="text-[11px] font-normal text-brand-400">{material.unit}</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </StatCard>

      <StatCard title={t('materials.detail.sections.warehouses')}>
        {stockError && <ErrorLine message={stockError} onRetry={loadStock} />}
        {!stock && !stockError && <PageSpinner />}
        {stock && stock.length === 0 && <p className="text-xs text-brand-400">{t('materials.stock.empty')}</p>}
        {stock && stock.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-brand-100">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('materials.stock.table.warehouse')}</TableHead>
                  <TableHead className="text-right">{t('materials.stock.table.quantity')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.map((s) => (
                  <TableRow key={s.warehouse_id}>
                    <TableCell className="text-xs text-brand-700">{s.warehouse?.name ?? '—'}</TableCell>
                    <TableCell className="text-right text-xs font-medium text-brand-800">
                      {formatQuantity(s.quantity, language)} {material.unit}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </StatCard>

      <StatCard title={t('materials.detail.sections.movements')}>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="w-44">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="!h-7 !rounded-lg !text-xs" aria-label={t('materials.detail.movements.filters.type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('materials.detail.movements.filters.allTypes')}</SelectItem>
                {MOVEMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(MATERIAL_MOVEMENT_TYPE_KEY[type])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-brand-500">
            {t('materials.detail.movements.filters.from')}
            <Input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} className="h-7 w-36 rounded-lg text-xs" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-brand-500">
            {t('materials.detail.movements.filters.to')}
            <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} className="h-7 w-36 rounded-lg text-xs" />
          </label>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setTypeFilter(ALL)
                setDateFrom('')
                setDateTo('')
              }}
            >
              {t('common.actions.clearFilters')}
            </Button>
          )}
        </div>

        {movementsError && <ErrorLine message={movementsError} onRetry={loadMovements} />}
        {!movements && !movementsError && <PageSpinner />}
        {movements && movements.length === 0 && !movementsError && <p className="text-xs text-brand-400">{hasFilters ? t('materials.detail.movements.empty') : t('materials.stock.noMovements')}</p>}
        {movements && movements.length > 0 && (
          <>
            <div className={`overflow-x-auto rounded-lg border border-brand-100 transition-opacity ${movementsLoading ? 'opacity-60' : ''}`}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('materials.detail.movements.table.date')}</TableHead>
                    <TableHead>{t('materials.detail.movements.table.type')}</TableHead>
                    <TableHead className="text-right">{t('materials.detail.movements.table.quantity')}</TableHead>
                    <TableHead>{t('materials.detail.movements.table.warehouse')}</TableHead>
                    <TableHead>{t('materials.detail.movements.table.reference')}</TableHead>
                    <TableHead>{t('materials.detail.movements.table.notes')}</TableHead>
                    <TableHead>{t('materials.detail.movements.table.user')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.map((m) => {
                    const entry = isMaterialEntry(m.movement_type)
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs text-brand-500">{formatDateTime(m.created_at, language)}</TableCell>
                        <TableCell className="text-xs text-brand-700">{t(MATERIAL_MOVEMENT_TYPE_KEY[m.movement_type])}</TableCell>
                        <TableCell className={`whitespace-nowrap text-right text-xs font-medium ${entry ? 'text-emerald-600' : 'text-red-600'}`}>
                          {entry ? '+' : '-'}
                          {formatQuantity(m.quantity, language)} {material.unit}
                        </TableCell>
                        <TableCell className="text-xs text-brand-500">{m.warehouse?.name ?? '—'}</TableCell>
                        <TableCell className="text-xs text-brand-600">
                          {m.reference_type ? t(`materials.referenceType.${m.reference_type}`) : '—'}
                          {m.reference_type === 'venta' && m.reference_id && (
                            <Link to={`/app/sales/${m.reference_id}`} className="ml-1.5 font-medium text-accent-600 hover:text-accent-700">
                              {t('materials.detail.movements.viewSale')}
                            </Link>
                          )}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-xs text-brand-500" title={m.notes ?? undefined}>
                          {m.notes ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs text-brand-500">{m.creator?.full_name ?? t('materials.detail.movements.system')}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            <Pagination page={page} totalPages={movementsPages} onChange={setPage} />
          </>
        )}
      </StatCard>

      <StatCard title={t('materials.detail.sections.usage')}>
        {usageError && <ErrorLine message={usageError} onRetry={loadUsage} />}
        {!usage && !usageError && <PageSpinner />}
        {usage && usage.length === 0 && <p className="text-xs text-brand-400">{t('materials.detail.usage.empty')}</p>}
        {usage && usage.length > 0 && (
          <>
            <div className="overflow-hidden rounded-lg border border-brand-100">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('materials.detail.usage.product')}</TableHead>
                    <TableHead className="text-right">{t('materials.detail.usage.perUnit')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs">
                        {l.product ? (
                          <Link to={`/app/products/${l.product.id}`} className="font-medium text-accent-600 hover:text-accent-700">
                            {l.product.name}
                          </Link>
                        ) : (
                          '—'
                        )}
                        {l.product?.sku && <span className="ml-1.5 text-brand-400">{l.product.sku}</span>}
                        {l.product && !l.product.is_active && (
                          <Badge variant="outline" className="ml-2">
                            {t('common.status.inactive')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-brand-700">
                        {formatQuantity(l.quantity, language)} {material.unit}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={usagePage} totalPages={usagePages} onChange={setUsagePage} />
          </>
        )}
      </StatCard>

      <MaterialDrawer open={editOpen} onClose={() => setEditOpen(false)} tenantId={tenantId} material={material} onSaved={reloadAll} />
      <MaterialStockDrawer open={adjustOpen} onClose={() => setAdjustOpen(false)} tenantId={tenantId} material={material} onSaved={reloadAll} showMovements={false} />
    </div>
  )
}
