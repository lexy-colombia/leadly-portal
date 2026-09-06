import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { Loader2Icon, SlidersHorizontalIcon, XIcon } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'
import { listStorefrontBrands, listStorefrontCategories, listStorefrontProducts, type StorefrontProductSummary } from '../../lib/api/storefront'
import { descendantIds } from '../../lib/api/productCategories'
import { useStorefrontCart } from '../../lib/useStorefrontCart'
import type { StorefrontOutletContext } from '../../layouts/StorefrontLayout'
import type { Brand, ProductCategory } from '../../types/domain'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import { StorefrontCategorySidebar } from '@/components/storefront/StorefrontCategorySidebar'
import { StorefrontOrderPanel } from '@/components/storefront/StorefrontOrderPanel'
import { ProductCard } from '@/components/storefront/ProductCard'

const ALL = '__all__'
type SortOption = 'name_asc' | 'price_asc' | 'price_desc' | 'newest'
// Scroll infinito -- pedido explícito del usuario: la carga inicial completa
// del catálogo (hasta 120 productos con imagen, marca, stock y variantes de
// cada uno) se sentía pesada. De a PAGE_SIZE en vez de todo de una.
const PAGE_SIZE = 20

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

/** Grilla de catálogo de 3 columnas (categorías | productos | pedido),
 * pedido explícito del usuario a partir de un mockup de referencia --
 * reemplaza el layout anterior (buscador propio + drawer de filtros con
 * categoría adentro, sin ningún carrito visible salvo el ícono del header).
 * La categoría vive ahora en un árbol siempre visible en la barra
 * izquierda (aplica al instante, sin "Aplicar"); el drawer de "Filtros"
 * quedó solo para marca y rango de precio. El carrito completo (con
 * cantidades editables) vive en la barra derecha en desktop -- el checkout
 * en sí sigue siendo la página aparte /carrito, son varios pasos de
 * formulario que no entran en una barra lateral. */
export function StorefrontCatalog() {
  const { slug, refreshCartCount, showError, search, searching, setSearching } = useOutletContext<StorefrontOutletContext>()
  const { t } = useLanguage()
  const [products, setProducts] = useState<StorefrontProductSummary[] | null>(null)
  const [total, setTotal] = useState<number | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // Cuántos productos ya se cargaron para esta combinación de filtros --
  // ref porque loadMore (disparado por el IntersectionObserver) necesita el
  // valor más reciente sin quedar atado a un closure viejo, y no hace falta
  // re-renderizar solo porque cambió.
  const offsetRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const [brands, setBrands] = useState<Brand[]>([])

  const [appliedCategoryId, setAppliedCategoryId] = useState<string | null>(null)
  const [appliedBrandId, setAppliedBrandId] = useState<string | null>(null)
  const [appliedSort, setAppliedSort] = useState<SortOption>('name_asc')
  const [appliedMinPrice, setAppliedMinPrice] = useState<number | undefined>(undefined)
  const [appliedMaxPrice, setAppliedMaxPrice] = useState<number | undefined>(undefined)

  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftBrandId, setDraftBrandId] = useState<string | null>(null)
  const [draftMinPrice, setDraftMinPrice] = useState('')
  const [draftMaxPrice, setDraftMaxPrice] = useState('')

  // Carrito completo (no solo cantidades) -- a diferencia del layout
  // anterior, la barra de "Tu pedido" necesita nombre/imagen/precio de cada
  // línea, no solo saber cuánto hay de cada producto para el indicador de
  // la card. Extraído a useStorefrontCart para compartirlo tal cual con
  // StorefrontProductDetail.tsx (mismo panel + misma protección contra
  // condiciones de carrera, ver ese hook).
  const { items, itemsByKey, totals, commitCartQuantity, commitPanelQuantity, handleCartCleared } = useStorefrontCart(slug, refreshCartCount, (err) =>
    showError(err instanceof Error ? err.message : t('storefront.catalog.updateError')),
  )

  useEffect(() => {
    listStorefrontCategories(slug)
      .then((res) => {
        setCategories(res.categories)
        // `?? {}` cubre además el backend viejo (sin este campo todavía) --
        // nunca debería crashear el árbol solo porque el conteo no llegó.
        setCategoryCounts(res.counts ?? {})
      })
      .catch(() => {
        setCategories([])
        setCategoryCounts({})
      })
    listStorefrontBrands(slug)
      .then((res) => setBrands(res.brands))
      .catch(() => setBrands([]))
  }, [slug])

  // Primera página de cada combinación de filtros -- reemplaza `products`
  // del todo (a diferencia de loadMore, que agrega). Reinicia offsetRef/
  // hasMore acá, no en loadMore, porque este efecto es lo único que corre
  // cuando cambia una búsqueda/filtro.
  useEffect(() => {
    let cancelled = false
    const categoryIds = appliedCategoryId ? [appliedCategoryId, ...descendantIds(categories, appliedCategoryId)] : undefined
    setSearching(true)
    const timeout = setTimeout(() => {
      listStorefrontProducts(slug, {
        search: search || undefined,
        category_ids: categoryIds,
        brand_id: appliedBrandId || undefined,
        min_price: appliedMinPrice,
        max_price: appliedMaxPrice,
        sort: appliedSort,
        offset: 0,
        limit: PAGE_SIZE,
      })
        .then((res) => {
          if (cancelled) return
          setProducts(res.products)
          setHasMore(res.has_more)
          setTotal(res.total)
          offsetRef.current = res.products.length
        })
        .catch((err) => {
          if (!cancelled) {
            setProducts([])
            setHasMore(false)
            showError(err instanceof Error ? err.message : t('storefront.catalog.loadError'))
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, search, appliedCategoryId, appliedBrandId, appliedMinPrice, appliedMaxPrice, appliedSort, categories])

  const loadMore = useCallback(() => {
    if (loadingMore || searching || !hasMore) return
    const categoryIds = appliedCategoryId ? [appliedCategoryId, ...descendantIds(categories, appliedCategoryId)] : undefined
    setLoadingMore(true)
    listStorefrontProducts(slug, {
      search: search || undefined,
      category_ids: categoryIds,
      brand_id: appliedBrandId || undefined,
      min_price: appliedMinPrice,
      max_price: appliedMaxPrice,
      sort: appliedSort,
      offset: offsetRef.current,
      limit: PAGE_SIZE,
    })
      .then((res) => {
        setProducts((prev) => [...(prev ?? []), ...res.products])
        setHasMore(res.has_more)
        offsetRef.current += res.products.length
      })
      .catch((err) => showError(err instanceof Error ? err.message : t('storefront.catalog.loadError')))
      .finally(() => setLoadingMore(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, search, appliedCategoryId, appliedBrandId, appliedMinPrice, appliedMaxPrice, appliedSort, categories, hasMore, loadingMore, searching])

  // Dispara loadMore cuando el centinela del final de la grilla entra en
  // viewport -- rootMargin adelanta el pedido ~400px antes de tocar el
  // fondo real, para que la próxima tanda ya esté en camino cuando el
  // usuario llega abajo, en vez de que vea el "cargando" recién al tope.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore])

  function openFilters() {
    setDraftBrandId(appliedBrandId)
    setDraftMinPrice(appliedMinPrice != null ? String(appliedMinPrice) : '')
    setDraftMaxPrice(appliedMaxPrice != null ? String(appliedMaxPrice) : '')
    setSheetOpen(true)
  }

  function applyFilters() {
    setAppliedBrandId(draftBrandId)
    setAppliedMinPrice(draftMinPrice ? Number(draftMinPrice) : undefined)
    setAppliedMaxPrice(draftMaxPrice ? Number(draftMaxPrice) : undefined)
    setSheetOpen(false)
  }

  function clearFilters() {
    setDraftBrandId(null)
    setDraftMinPrice('')
    setDraftMaxPrice('')
    setAppliedBrandId(null)
    setAppliedMinPrice(undefined)
    setAppliedMaxPrice(undefined)
    setSheetOpen(false)
  }

  const hasPriceFilter = appliedMinPrice != null || appliedMaxPrice != null
  const hasActiveFilters = !!appliedBrandId || hasPriceFilter
  const selectedCategory = appliedCategoryId ? categories.find((c) => c.id === appliedCategoryId) : undefined

  return (
    <div className="space-y-4">
      <nav className="text-xs text-muted-foreground">
        <Link to={`/tienda/${slug}`} className="hover:text-foreground hover:underline">
          {t('storefront.breadcrumb.home')}
        </Link>
        <span> / </span>
        <span className="text-foreground">{selectedCategory?.name ?? t('storefront.catalog.title')}</span>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[200px_1fr_300px] xl:grid-cols-[220px_1fr_320px]">
        <aside className="hidden lg:block">
          <StorefrontCategorySidebar
            categories={categories}
            counts={categoryCounts}
            selectedId={appliedCategoryId}
            onSelect={setAppliedCategoryId}
            title={t('storefront.categories.title')}
            allLabel={t('storefront.categories.viewAll')}
          />
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-foreground sm:text-2xl">{selectedCategory?.name ?? t('storefront.catalog.title')}</h1>
              {total != null && <p className="text-xs text-muted-foreground">{t('storefront.catalog.productCount', { count: total })}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Select value={appliedSort} onValueChange={(v) => setAppliedSort(v as SortOption)}>
                <SelectTrigger className="h-9 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name_asc">{t('storefront.filters.sortNameAsc')}</SelectItem>
                  <SelectItem value="price_asc">{t('storefront.filters.sortPriceAsc')}</SelectItem>
                  <SelectItem value="price_desc">{t('storefront.filters.sortPriceDesc')}</SelectItem>
                  <SelectItem value="newest">{t('storefront.filters.sortNewest')}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="lg" className="h-9 shrink-0" onClick={openFilters}>
                <SlidersHorizontalIcon />
                {t('storefront.filters.title')}
              </Button>
            </div>
          </div>

          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-2">
              {appliedBrandId && (
                <FilterChip label={t('storefront.filters.chipBrand', { name: brands.find((b) => b.id === appliedBrandId)?.name ?? '' })} onRemove={() => setAppliedBrandId(null)} />
              )}
              {hasPriceFilter && (
                <FilterChip
                  label={t('storefront.filters.chipPrice', {
                    min: formatCurrency(appliedMinPrice ?? 0),
                    max: appliedMaxPrice != null ? formatCurrency(appliedMaxPrice) : '∞',
                  })}
                  onRemove={() => {
                    setAppliedMinPrice(undefined)
                    setAppliedMaxPrice(undefined)
                  }}
                />
              )}
              <button type="button" onClick={clearFilters} className="text-xs font-medium text-primary hover:underline">
                {t('storefront.filters.clearAll')}
              </button>
            </div>
          )}

          {products === null ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[3/4] w-full" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <p className="py-16 text-center text-xs text-muted-foreground">{t('storefront.catalog.empty')}</p>
          ) : (
            <div className={`grid grid-cols-2 gap-3 transition-opacity duration-200 sm:grid-cols-3 ${searching ? 'opacity-50' : 'opacity-100'}`}>
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  slug={slug}
                  product={product}
                  getCartQuantity={(key) => itemsByKey.get(key)?.quantity ?? 0}
                  onCommit={(key, variantId, quantity) => commitCartQuantity(key, product.id, variantId, quantity)}
                />
              ))}
            </div>
          )}

          {products !== null && products.length > 0 && (hasMore || loadingMore) && (
            <div ref={sentinelRef} className="flex justify-center py-4">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        <aside className="hidden lg:block">
          <StorefrontOrderPanel slug={slug} items={items} totals={totals} onCommit={commitPanelQuantity} onClear={handleCartCleared} onError={showError} />
        </aside>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="flex flex-col">
          <SheetHeader>
            <SheetTitle>{t('storefront.filters.title')}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 space-y-5 overflow-y-auto px-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t('storefront.filters.brand')}</p>
              <Select value={draftBrandId ?? ALL} onValueChange={(v) => setDraftBrandId(v === ALL ? null : v)}>
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder={t('storefront.filters.allBrands')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('storefront.filters.allBrands')}</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t('storefront.filters.price')}</p>
              <div className="flex items-center gap-2">
                <Input type="number" inputMode="numeric" min={0} placeholder={t('storefront.filters.priceMin')} value={draftMinPrice} onChange={(e) => setDraftMinPrice(e.target.value)} className="h-9 text-xs" />
                <span className="text-xs text-muted-foreground">–</span>
                <Input type="number" inputMode="numeric" min={0} placeholder={t('storefront.filters.priceMax')} value={draftMaxPrice} onChange={(e) => setDraftMaxPrice(e.target.value)} className="h-9 text-xs" />
              </div>
            </div>
          </div>
          <SheetFooter className="flex-row">
            <Button variant="outline" className="flex-1" onClick={clearFilters}>
              {t('storefront.filters.clear')}
            </Button>
            <Button className="flex-1" onClick={applyFilters}>
              {t('storefront.filters.apply')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge variant="secondary" className="animate-in zoom-in-95 gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs font-normal">
      {label}
      <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-background/60" aria-label={label}>
        <XIcon className="size-3" />
      </button>
    </Badge>
  )
}

