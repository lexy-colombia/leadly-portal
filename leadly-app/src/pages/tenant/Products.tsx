import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useHeaderSearchSlot } from '@/contexts/HeaderSearchSlotContext'
import { bulkSetVisibleInCatalog, deleteProduct, getProductImageUrl, listProducts, updateProduct } from '../../lib/api/products'
import type { ProductWithImages } from '../../lib/api/products'
import { listStockByWarehouse, listStockTotalsByTenant, recordStockMovement } from '../../lib/api/stockMovements'
import type { ProductStockTotal, ProductWarehouseStockRow } from '../../lib/api/stockMovements'
import { descendantIds, listProductCategories } from '../../lib/api/productCategories'
import { listBrands } from '../../lib/api/brands'
import { listWarehouses } from '../../lib/api/warehouses'
import type { Brand, ProductCategory, Warehouse } from '../../types/domain'
import { PageSpinner, ProductImage } from '@/components/atoms'
import { Card, CategoryTreeFilter, ComboboxFilter, EmptyState, FilterField, IconInput, Pagination } from '@/components/molecules'
import { AlertIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ProductDrawer } from './products/ProductDrawer'

const PAGE_SIZE = 10
// Shared by every filter trigger (category/brand/warehouse/low-stock) so
// they line up as one uniform row of pills instead of each auto-sizing to
// its own label. Warehouse uses ComboboxFilter (not a shadcn Select) for the
// same reason -- Select's trigger has its own hardcoded border/background/
// hover tokens (border-input, bg-transparent, no hover state) completely
// separate from Button's "outline" variant, so no shared className could
// ever make the two look alike; reusing the exact same Button-based trigger
// component is what actually guarantees it.
const FILTER_TRIGGER_CLASS = 'w-40 rounded-lg text-xs'

function formatCurrency(value: number | null, currency: string): string {
  if (value == null) return '-'
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** `products` carries no stock counter of its own (see types/domain.ts) --
 * "available" is always the sum across warehouses (product_stock), looked
 * up from the `stockTotals` map loaded alongside the list. What's actually
 * sellable right now excludes anything held by open cotizaciones
 * (reserved), even though it's still physically on the shelf. */
function availableStock(product: ProductWithImages, stockTotals: Map<string, ProductStockTotal>): number {
  return stockTotals.get(product.id)?.available ?? 0
}

function isLowStock(product: ProductWithImages, stockTotals: Map<string, ProductStockTotal>): boolean {
  return product.track_inventory && availableStock(product, stockTotals) <= product.low_stock_threshold
}

function warehouseStock(rows: ProductWarehouseStockRow[], productId: string, warehouseId: string): number {
  return rows.filter((r) => r.product_id === productId && r.warehouse_id === warehouseId && r.variant_id === null).reduce((sum, r) => sum + r.quantity, 0)
}

/** Click-to-edit del stock directo desde la lista, mismo espíritu que el
 * Switch de Activo/Inactivo de al lado -- pedido explícito del usuario de
 * no tener que entrar al detalle del producto solo para corregir una
 * cantidad. Como el modelo real es un kardex (stock_movements, ver
 * CLAUDE.md), no hay ningún campo "cantidad" que sobreescribir: lo que el
 * usuario tipea acá se compara contra lo que ya hay y se registra como un
 * ajuste_positivo/ajuste_negativo por la diferencia, igual que haría a
 * mano desde StockMovementDrawer. Solo se ofrece para productos sin
 * variantes (`has_variants`) -- con variantes el número de la lista es una
 * suma entre combinaciones y bodegas, no hay "una" cantidad que editar acá
 * sin antes elegir cuál variante, eso sigue viviendo en el detalle. */
function QuickStockPopover({
  product,
  warehouses,
  stockRows,
  currentTotal,
  lowStock,
  onSaved,
}: {
  product: ProductWithImages
  warehouses: Warehouse[]
  stockRows: ProductWarehouseStockRow[]
  currentTotal: number
  lowStock: boolean
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const defaultWarehouseId = warehouses.find((w) => w.is_default)?.id ?? warehouses[0]?.id ?? ''
  const singleWarehouse = warehouses.length <= 1

  const [open, setOpen] = useState(false)
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId)
  const [quantity, setQuantity] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function currentFor(id: string): number {
    return singleWarehouse ? currentTotal : warehouseStock(stockRows, product.id, id)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setWarehouseId(defaultWarehouseId)
      setQuantity(String(currentFor(defaultWarehouseId)))
      setError(null)
    }
  }

  async function handleSave() {
    if (!warehouseId) return
    const target = Number(quantity)
    if (!Number.isFinite(target) || target < 0) {
      setError(t('products.table.quickStock.invalid'))
      return
    }
    const delta = target - currentFor(warehouseId)
    if (delta === 0) {
      setOpen(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await recordStockMovement({
        tenant_id: product.tenant_id,
        product_id: product.id,
        warehouse_id: warehouseId,
        movement_type: delta > 0 ? 'ajuste_positivo' : 'ajuste_negativo',
        quantity: Math.abs(delta),
      })
      setOpen(false)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.table.quickStock.error'))
    } finally {
      setSaving(false)
    }
  }

  if (warehouses.length === 0) {
    return (
      <Badge variant={lowStock ? 'destructive' : 'secondary'}>
        {t('products.table.available', { count: currentTotal })} {lowStock && t('products.table.low')}
      </Badge>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent-300">
          <Badge variant={lowStock ? 'destructive' : 'secondary'} className="cursor-pointer transition hover:brightness-95">
            {t('products.table.available', { count: currentTotal })} {lowStock && t('products.table.low')}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <p className="text-xs font-semibold text-brand-800">{t('products.table.quickStock.title')}</p>

        {!singleWarehouse && (
          <div>
            <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('products.table.quickStock.warehouse')}</span>
            <Select
              value={warehouseId}
              onValueChange={(v) => {
                setWarehouseId(v)
                setQuantity(String(currentFor(v)))
              }}
            >
              <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id} className="text-xs">
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div>
          <span className="mb-0.5 block text-[11px] font-medium text-brand-400">{t('products.table.quickStock.quantity')}</span>
          <Input
            type="number"
            min="0"
            step="1"
            autoFocus
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSave()
              }
            }}
            className="text-right"
          />
        </div>

        {error && <p className="text-xs font-medium text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-0.5">
          <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)} disabled={saving}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="button" size="xs" onClick={handleSave} disabled={saving}>
            {saving ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Proveedores se sacó de acá el 2026-08-17 (ruta propia
 * /app/products/suppliers, ver Suppliers.tsx/modules.ts) -- pedido
 * explícito del usuario de que "Productos" sea solo el catálogo, no un
 * contenedor de tabs. La columna Proveedor también se sacó de la tabla por
 * el mismo pedido (sigue siendo un campo editable en ProductDrawer, solo
 * dejó de mostrarse acá). Paginación y filtros pasaron a ser server-side
 * (listProducts ahora pide de a PAGE_SIZE con `.range()`, no trae el
 * catálogo completo) -- necesario apenas el catálogo de un tenant real
 * empieza a tener cientos de productos (ver seed de 100 productos de
 * Tenant QA Uno). */
export function Products() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const tenantId = profile?.tenant_id
  const { slot: headerSearchSlot } = useHeaderSearchSlot()

  const [products, setProducts] = useState<ProductWithImages[] | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [stockTotals, setStockTotals] = useState<Map<string, ProductStockTotal>>(new Map())
  const [stockRows, setStockRows] = useState<ProductWarehouseStockRow[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [brandId, setBrandId] = useState<string | null>(null)
  const [warehouseId, setWarehouseId] = useState<string | null>(null)
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [page, setPage] = useState(1)

  const [drawer, setDrawer] = useState<{ open: boolean; product: ProductWithImages | null }>({ open: false, product: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkUpdating, setBulkUpdating] = useState(false)

  // Debounced so typing a search term doesn't fire a DB round trip per
  // keystroke -- the query only runs 350ms after the user stops typing.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350)
    return () => clearTimeout(timer)
  }, [search])

  // Reference lists for the filter pickers -- small enough (a tenant's
  // categories/brands/warehouses realistically never run into the hundreds)
  // to load in full once, unlike the products list itself.
  useEffect(() => {
    if (!tenantId) return
    listProductCategories(tenantId).then(setCategories).catch(() => {})
    listBrands(tenantId).then(setBrands).catch(() => {})
    listWarehouses(tenantId).then(setWarehouses).catch(() => {})
  }, [tenantId])

  // Picking a category filters its whole subtree, not just that exact row --
  // browsing "Audio" should show every audífono/parlante/micrófono under it,
  // not require drilling all the way to a leaf first.
  const categoryIds = useMemo(() => {
    if (!categoryId) return undefined
    return [categoryId, ...Array.from(descendantIds(categories, categoryId))]
  }, [categoryId, categories])

  const hasActiveFilters = Boolean(debouncedSearch || categoryId || brandId || warehouseId || lowStockOnly)

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, categoryIds, brandId, warehouseId, lowStockOnly])

  function reload() {
    if (!tenantId) return
    setLoading(true)
    setError(null)
    listProducts(tenantId, { page, pageSize: PAGE_SIZE, search: debouncedSearch, categoryIds, brandId, warehouseId, lowStockOnly })
      .then(({ data, count }) => {
        setProducts(data)
        setTotalCount(count)
        // Keeps an open edit drawer in sync (e.g. right after an image
        // upload/removal) instead of holding on to the stale snapshot it was
        // opened with -- the drawer's `product` prop is separate state from
        // this list, so a plain reload alone wouldn't reach it.
        setDrawer((prev) => (prev.product ? { ...prev, product: data.find((p) => p.id === prev.product!.id) ?? prev.product } : prev))
      })
      .catch((err) => setError(err.message ?? t('products.errors.load')))
      .finally(() => setLoading(false))
    listStockTotalsByTenant(tenantId).then(setStockTotals).catch(() => {})
    // Desglose por bodega para QuickStockPopover cuando hay más de una --
    // se pide siempre (no solo si `warehouses.length > 1`) porque ese
    // estado se carga en un efecto aparte y todavía puede estar vacío la
    // primera vez que `reload` corre, dejando el prefill del popover en 0
    // para un tenant multi-bodega hasta el próximo reload.
    listStockByWarehouse(tenantId).then(setStockRows).catch(() => {})
  }

  useEffect(reload, [tenantId, page, debouncedSearch, categoryIds, brandId, warehouseId, lowStockOnly])

  // A selection tied to ids from the previous page/filter would silently
  // apply a bulk action to products the user can no longer see -- clearing
  // it whenever the list itself changes keeps "selected" always in sync
  // with what's on screen.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [products])

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteProduct(id)
      setDeletingId(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  async function handleToggleActive(product: ProductWithImages, checked: boolean) {
    setTogglingId(product.id)
    setProducts((list) => (list ? list.map((p) => (p.id === product.id ? { ...p, is_active: checked } : p)) : list))
    try {
      await updateProduct(product.id, { is_active: checked })
    } catch (err) {
      setProducts((list) => (list ? list.map((p) => (p.id === product.id ? { ...p, is_active: !checked } : p)) : list))
      setError(err instanceof Error ? err.message : t('products.errors.save'))
    } finally {
      setTogglingId(null)
    }
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked && products ? new Set(products.map((p) => p.id)) : new Set())
  }

  function toggleSelectOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function handleBulkSetVisible(visible: boolean) {
    const ids = Array.from(selectedIds)
    setBulkUpdating(true)
    setError(null)
    try {
      await bulkSetVisibleInCatalog(ids, visible)
      setSelectedIds(new Set())
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.list.bulk.error'))
    } finally {
      setBulkUpdating(false)
    }
  }

  if (!tenantId) return <PageSpinner />

  return (
    <div className="space-y-3">
      {headerSearchSlot &&
        createPortal(
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('products.list.searchPlaceholder')}
            className="!w-64 !rounded-lg !py-1.5 text-xs"
          />,
          headerSearchSlot,
        )}

      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-brand-100 bg-brand-50/40 p-3">
        <FilterField label={t('products.list.labels.category')}>
          <CategoryTreeFilter
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            placeholder={t('products.list.allCategories')}
            searchPlaceholder={t('products.list.searchCategory')}
            emptyLabel={t('products.list.noCategoryResults')}
            rootLabel={t('products.list.allCategories')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('products.list.labels.brand')}>
          <ComboboxFilter
            options={brands.map((b) => ({ id: b.id, label: b.name }))}
            value={brandId}
            onChange={setBrandId}
            placeholder={t('products.list.allBrands')}
            searchPlaceholder={t('products.list.searchBrand')}
            emptyLabel={t('products.list.noBrandResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('products.list.labels.warehouse')}>
          <ComboboxFilter
            options={warehouses.map((w) => ({ id: w.id, label: w.name }))}
            value={warehouseId}
            onChange={setWarehouseId}
            placeholder={t('products.list.allWarehouses')}
            searchPlaceholder={t('products.list.searchWarehouse')}
            emptyLabel={t('products.list.noWarehouseResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('products.list.labels.stock')}>
          <Button type="button" variant={lowStockOnly ? 'secondary' : 'outline'} size="sm" className={FILTER_TRIGGER_CLASS} onClick={() => setLowStockOnly((v) => !v)}>
            <AlertIcon width={13} height={13} /> {t('products.list.lowStockFilter')}
          </Button>
        </FilterField>

        <span className="shrink-0 pb-1.5 text-xs text-brand-400">
          {totalCount} {t(totalCount === 1 ? 'products.count.singular' : 'products.count.plural')}
        </span>

        <Button onClick={() => setDrawer({ open: true, product: null })} size="sm" className="ml-auto self-center">
          <PlusIcon width={14} height={14} /> {t('products.actions.new')}
        </Button>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-brand-100 bg-brand-50/40 px-3 py-2">
          <span className="text-xs font-medium text-brand-700">{t('products.list.bulk.selected', { count: selectedIds.size })}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={bulkUpdating} onClick={() => handleBulkSetVisible(true)}>
              {t('products.list.bulk.showInStore')}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={bulkUpdating} onClick={() => handleBulkSetVisible(false)}>
              {t('products.list.bulk.hideFromStore')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={bulkUpdating} onClick={() => setSelectedIds(new Set())}>
              {t('products.list.bulk.clear')}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {loading && !products && <PageSpinner />}

      {products && products.length === 0 && (
        <Card>
          <EmptyState>{hasActiveFilters ? t('products.empty.noMatch') : t('products.empty.none')}</EmptyState>
        </Card>
      )}

      {products && products.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={products.length > 0 && selectedIds.size === products.length ? true : selectedIds.size > 0 ? 'indeterminate' : false}
                      onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                    />
                  </TableHead>
                  <TableHead></TableHead>
                  <TableHead>{t('products.table.product')}</TableHead>
                  <TableHead>{t('products.table.brand')}</TableHead>
                  <TableHead>{t('products.table.category')}</TableHead>
                  <TableHead>{t('products.table.price')}</TableHead>
                  <TableHead>{t('products.table.stock')}</TableHead>
                  <TableHead>{t('products.table.active')}</TableHead>
                  <TableHead className="text-right">{t('products.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => {
                  const lowStock = isLowStock(product, stockTotals)
                  const cover = product.images[0]
                  return (
                    <TableRow key={product.id} onClick={() => navigate(`/app/products/${product.id}`)} className="cursor-pointer">
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={selectedIds.has(product.id)} onCheckedChange={(checked) => toggleSelectOne(product.id, checked === true)} />
                      </TableCell>
                      <TableCell>
                        <div className="h-9 w-9 overflow-hidden rounded-lg border border-brand-100">
                          <ProductImage src={cover ? getProductImageUrl(cover.storage_path) : null} name={product.name} className="h-full w-full" iconSize={16} />
                        </div>
                      </TableCell>
                      <TableCell className="text-xs font-medium text-brand-800">
                        {product.name}
                        {product.sku && <span className="block text-xs font-normal text-brand-400">{t('products.table.sku', { sku: product.sku })}</span>}
                      </TableCell>
                      <TableCell className="text-xs text-brand-500">{product.brand?.name ?? '-'}</TableCell>
                      <TableCell className="text-xs text-brand-500">
                        {product.categories.length > 0 ? (
                          // Sin punto de color por categoría por ahora -- con
                          // la cadena completa de ancestros (raíz→hoja) un
                          // producto normalmente trae 2-3 categorías, y un
                          // color distinto por cada una se veía cargado sin
                          // aportar información real (pedido explícito del
                          // usuario). Chips de texto plano, más legibles en
                          // una celda angosta.
                          <span className="flex flex-wrap gap-1">
                            {product.categories.map((c) => (
                              <span key={c.id} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs whitespace-nowrap text-brand-500">
                                {c.name}
                              </span>
                            ))}
                          </span>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-brand-700">{formatCurrency(product.retail_price, product.currency)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {!product.track_inventory ? (
                          <span className="text-xs text-brand-400">{t('products.table.noControl')}</span>
                        ) : product.has_variants ? (
                          <Badge variant={lowStock ? 'destructive' : 'secondary'}>
                            {t('products.table.available', { count: availableStock(product, stockTotals) })} {lowStock && t('products.table.low')}
                          </Badge>
                        ) : (
                          <QuickStockPopover
                            product={product}
                            warehouses={warehouses}
                            stockRows={stockRows}
                            currentTotal={availableStock(product, stockTotals)}
                            lowStock={lowStock}
                            onSaved={reload}
                          />
                        )}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={product.is_active}
                          disabled={togglingId === product.id}
                          onCheckedChange={(checked) => handleToggleActive(product, checked)}
                          aria-label={t(product.is_active ? 'common.status.active' : 'common.status.inactive')}
                        />
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {deletingId === product.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Button variant="destructive" size="xs" onClick={() => handleDelete(product.id)} disabled={deleting}>
                              {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                            </Button>
                            <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                              {t('common.actions.cancel')}
                            </Button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, product })}>
                              <PencilIcon width={12} height={12} />
                            </Button>
                            <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setDeletingId(product.id)}>
                              <TrashIcon width={12} height={12} />
                            </Button>
                          </span>
                        )}
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

      <ProductDrawer open={drawer.open} onClose={() => setDrawer({ open: false, product: null })} tenantId={tenantId} product={drawer.product} onSaved={reload} />
    </div>
  )
}
