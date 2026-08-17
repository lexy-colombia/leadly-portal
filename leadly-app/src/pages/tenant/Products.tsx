import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { deleteProduct, getProductImageUrl, listProducts } from '../../lib/api/products'
import type { ProductWithImages } from '../../lib/api/products'
import { listStockTotalsByTenant } from '../../lib/api/stockMovements'
import type { ProductStockTotal } from '../../lib/api/stockMovements'
import { Badge, Button, PageSpinner, Select, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { AlertIcon, BoxIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/atoms/icons'
import { ProductDrawer } from './products/ProductDrawer'
import { SuppliersTab } from './products/SuppliersTab'

const PAGE_SIZE = 10

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

function ProductsTab({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [products, setProducts] = useState<ProductWithImages[] | null>(null)
  const [stockTotals, setStockTotals] = useState<Map<string, ProductStockTotal>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; product: ProductWithImages | null }>({ open: false, product: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listProducts(tenantId)
      .then((data) => {
        setProducts(data)
        // Keeps an open edit drawer in sync (e.g. right after an image
        // upload/removal) instead of holding on to the stale snapshot it was
        // opened with -- the drawer's `product` prop is separate state from
        // this list, so a plain reload alone wouldn't reach it.
        setDrawer((prev) => (prev.product ? { ...prev, product: data.find((p) => p.id === prev.product!.id) ?? prev.product } : prev))
      })
      .catch((err) => setError(err.message ?? t('products.errors.load')))
    listStockTotalsByTenant(tenantId).then(setStockTotals).catch(() => {})
  }

  useEffect(reload, [tenantId])

  const categories = useMemo(() => {
    if (!products) return []
    const map = new Map<string, string>()
    products.forEach((p) => p.category && map.set(p.category.id, p.category.name))
    return Array.from(map.entries())
  }, [products])

  const lowStockCount = useMemo(
    () => (products ? products.filter((p) => isLowStock(p, stockTotals)).length : 0),
    [products, stockTotals],
  )

  const filtered = useMemo(() => {
    if (!products) return null
    const term = search.trim().toLowerCase()
    return products.filter((p) => {
      if (categoryFilter && p.category_id !== categoryFilter) return false
      if (lowStockOnly && !isLowStock(p, stockTotals)) return false
      if (!term) return true
      return p.name.toLowerCase().includes(term) || (p.sku ?? '').toLowerCase().includes(term)
    })
  }, [products, search, categoryFilter, lowStockOnly, stockTotals])

  useEffect(() => {
    setPage(1)
  }, [search, categoryFilter, lowStockOnly])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteProduct(id)
      setProducts((prev) => (prev ? prev.filter((p) => p.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconInput
          icon={<SearchIcon width={14} height={14} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('products.list.searchPlaceholder')}
          className="!w-56 !py-1 text-xs"
        />

        <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="!w-auto !py-1 text-xs">
          <option value="">{t('products.list.allCategories')}</option>
          {categories.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>

        <button
          type="button"
          onClick={() => setLowStockOnly((v) => !v)}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
            lowStockOnly ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-brand-200 text-brand-500 hover:bg-brand-50'
          }`}
        >
          <AlertIcon width={13} height={13} />
          {t('products.list.lowStockFilter')} {lowStockCount > 0 && `(${lowStockCount})`}
        </button>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {t((filtered?.length ?? 0) === 1 ? 'products.count.singular' : 'products.count.plural')}
        </span>

        <Button variant="secondary" onClick={() => setDrawer({ open: true, product: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> {t('products.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!products && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>{products && products.length > 0 ? t('products.empty.noMatch') : t('products.empty.none')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <TH></TH>
                <TH>{t('products.table.product')}</TH>
                <TH>{t('products.table.category')}</TH>
                <TH>{t('products.table.supplier')}</TH>
                <TH>{t('products.table.price')}</TH>
                <TH>{t('products.table.stock')}</TH>
                <TH>{t('products.table.status')}</TH>
                <TH className="text-right">{t('products.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((product) => {
                const lowStock = isLowStock(product, stockTotals)
                const reserved = stockTotals.get(product.id)?.reserved ?? 0
                const cover = product.images[0]
                return (
                  <TRow key={product.id}>
                    <TD>
                      <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-brand-100 bg-brand-50 text-brand-300">
                        {cover ? <img src={getProductImageUrl(cover.storage_path)} alt="" className="h-full w-full object-cover" /> : <BoxIcon width={16} height={16} />}
                      </div>
                    </TD>
                    <TD className="text-xs font-medium text-brand-800">
                      <Link to={`/app/productos/${product.id}`} className="hover:text-accent-600 hover:underline">
                        {product.name}
                      </Link>
                      {product.sku && <span className="block text-[11px] font-normal text-brand-400">{t('products.table.sku', { sku: product.sku })}</span>}
                    </TD>
                    <TD className="text-xs text-brand-500">
                      {product.category ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: product.category.color ?? '#94A3B8' }} />
                          {product.category.name}
                        </span>
                      ) : (
                        '-'
                      )}
                    </TD>
                    <TD className="text-xs text-brand-500">{product.supplier?.name ?? '-'}</TD>
                    <TD className="text-xs text-brand-700">{formatCurrency(product.retail_price, product.currency)}</TD>
                    <TD>
                      {product.track_inventory ? (
                        <Badge tone={lowStock ? 'danger' : 'neutral'}>
                          {t('products.table.available', { count: availableStock(product, stockTotals) })} {lowStock && t('products.table.low')}
                        </Badge>
                      ) : (
                        <span className="text-xs text-brand-400">{t('products.table.noControl')}</span>
                      )}
                      {reserved > 0 && <span className="ml-1.5 text-[11px] text-brand-400">{t('products.table.reserved', { count: reserved })}</span>}
                    </TD>
                    <TD>
                      <Badge tone={product.is_active ? 'success' : 'neutral'}>{t(product.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                    </TD>
                    <TD className="text-right">
                      {deletingId === product.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="danger" onClick={() => handleDelete(product.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" onClick={() => setDrawer({ open: true, product })} className="!px-2 !py-1 text-xs">
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button variant="ghost" onClick={() => setDeletingId(product.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                            <TrashIcon width={12} height={12} />
                          </Button>
                        </span>
                      )}
                    </TD>
                  </TRow>
                )
              })}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <ProductDrawer open={drawer.open} onClose={() => setDrawer({ open: false, product: null })} tenantId={tenantId} product={drawer.product} onSaved={reload} />
    </div>
  )
}

// Categorías y Brands se movieron a rutas propias (/app/productos/categorias,
// /app/productos/marcas) el 2026-08-16 -- "Products" pasó a ser un ítem de
// nav expandible con esas dos como hijos (ver modules.ts/TenantLayout.tsx),
// así que ya no tiene sentido tenerlas también como tab acá. Proveedores no
// se tocó, se queda como tab -- no se pidió sacarla también.
export function Products() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [tab, setTab] = useState<'productos' | 'proveedores'>('productos')

  if (!profile?.tenant_id) return <PageSpinner />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-brand-100">
        {(
          [
            ['productos', t('products.tabs.products')],
            ['proveedores', t('products.tabs.suppliers')],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === value ? 'border-accent-500 text-accent-700' : 'border-transparent text-brand-400 hover:text-brand-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'productos' && <ProductsTab tenantId={profile.tenant_id} />}
      {tab === 'proveedores' && <SuppliersTab tenantId={profile.tenant_id} />}
    </div>
  )
}
