import { useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { Loader2Icon, MinusIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'
import {
  addToStorefrontCart,
  getStorefrontCart,
  listStorefrontBrands,
  listStorefrontCategories,
  listStorefrontProducts,
  removeStorefrontCartItem,
  updateStorefrontCartItem,
  type StorefrontProductSummary,
} from '../../lib/api/storefront'
import { descendantIds } from '../../lib/api/productCategories'
import { getStorefrontCartToken, setStorefrontCartToken } from '../../lib/storefrontCart'
import type { StorefrontOutletContext } from '../../layouts/StorefrontLayout'
import type { Brand, ProductCategory } from '../../types/domain'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CategoryTreeFilter } from '@/components/molecules'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'

const ALL = '__all__'
type SortOption = 'name_asc' | 'price_asc' | 'price_desc' | 'newest'
const LOW_STOCK_THRESHOLD = 5

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

/** Grilla de catálogo, estilo shadcn -- buscador siempre en vivo + un drawer
 * de filtros "profesional" a la derecha (marca, árbol de categorías, orden),
 * que solo se aplica al tocar "Aplicar" (o se limpia con "Borrar"), en vez de
 * refiltrar en cada click. Los filtros activos solo se ven como el badge
 * numérico sobre el botón "Filtros" -- pedido explícito: nada de chips
 * sueltos en el home, esa vista vive adentro del drawer. */
export function StorefrontCatalog() {
  const { slug, refreshCartCount, showError } = useOutletContext<StorefrontOutletContext>()
  const { t } = useLanguage()
  const [products, setProducts] = useState<StorefrontProductSummary[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [search, setSearch] = useState('')

  const [appliedCategoryId, setAppliedCategoryId] = useState<string | null>(null)
  const [appliedBrandId, setAppliedBrandId] = useState<string | null>(null)
  const [appliedSort, setAppliedSort] = useState<SortOption>('name_asc')

  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftCategoryId, setDraftCategoryId] = useState<string | null>(null)
  const [draftBrandId, setDraftBrandId] = useState<string | null>(null)
  const [draftSort, setDraftSort] = useState<SortOption>('name_asc')

  const [addingId, setAddingId] = useState<string | null>(null)
  // product_id (simples) o variant_id (con variantes) -> ítem real del
  // carrito -- pedido explícito: "no se cual ya agregué, no es claro eso" +
  // "si algo ya está agregado, quita el botón de agregar y poné ahí el
  // indicador de cantidades para poder modificarlas". Guarda el itemId (no
  // solo la cantidad) porque modificar/quitar necesita ese id, no el
  // product_id/variant_id.
  const [cartItems, setCartItems] = useState<Map<string, { itemId: string; quantity: number }>>(new Map())

  const loadCartItems = useCallback(() => {
    const token = getStorefrontCartToken(slug)
    if (!token) {
      setCartItems(new Map())
      return
    }
    getStorefrontCart(token)
      .then((res) => {
        const map = new Map<string, { itemId: string; quantity: number }>()
        for (const item of res.items) {
          const key = item.variant_id ?? item.product_id
          const existing = map.get(key)
          map.set(key, { itemId: item.id, quantity: (existing?.quantity ?? 0) + item.quantity })
        }
        setCartItems(map)
      })
      .catch(() => setCartItems(new Map()))
  }, [slug])

  useEffect(() => {
    loadCartItems()
  }, [loadCartItems])

  useEffect(() => {
    listStorefrontCategories(slug)
      .then((res) => setCategories(res.categories))
      .catch(() => setCategories([]))
    listStorefrontBrands(slug)
      .then((res) => setBrands(res.brands))
      .catch(() => setBrands([]))
  }, [slug])

  useEffect(() => {
    let cancelled = false
    const categoryIds = appliedCategoryId ? [appliedCategoryId, ...descendantIds(categories, appliedCategoryId)] : undefined
    setSearching(true)
    const timeout = setTimeout(() => {
      listStorefrontProducts(slug, {
        search: search || undefined,
        category_ids: categoryIds,
        brand_id: appliedBrandId || undefined,
        sort: appliedSort,
      })
        .then((res) => {
          if (!cancelled) setProducts(res.products)
        })
        .catch((err) => {
          if (!cancelled) {
            setProducts([])
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
  }, [slug, search, appliedCategoryId, appliedBrandId, appliedSort, categories])

  function openFilters() {
    setDraftCategoryId(appliedCategoryId)
    setDraftBrandId(appliedBrandId)
    setDraftSort(appliedSort)
    setSheetOpen(true)
  }

  function applyFilters() {
    setAppliedCategoryId(draftCategoryId)
    setAppliedBrandId(draftBrandId)
    setAppliedSort(draftSort)
    setSheetOpen(false)
  }

  function clearFilters() {
    setDraftCategoryId(null)
    setDraftBrandId(null)
    setDraftSort('name_asc')
    setAppliedCategoryId(null)
    setAppliedBrandId(null)
    setAppliedSort('name_asc')
    setSheetOpen(false)
  }

  const activeFilterCount = (appliedCategoryId ? 1 : 0) + (appliedBrandId ? 1 : 0) + (appliedSort !== 'name_asc' ? 1 : 0)

  async function handleQuickAdd(product: StorefrontProductSummary, variantId?: string) {
    const key = variantId ?? product.id
    setAddingId(key)
    try {
      const result = await addToStorefrontCart({
        slug,
        session_token: getStorefrontCartToken(slug),
        product_id: product.id,
        variant_id: variantId,
        quantity: 1,
      })
      setStorefrontCartToken(slug, result.session_token)
      refreshCartCount()
      loadCartItems()
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.product.addError'))
    } finally {
      setAddingId(null)
    }
  }

  async function handleDecrement(key: string) {
    const entry = cartItems.get(key)
    const token = getStorefrontCartToken(slug)
    if (!entry || !token) return
    setAddingId(key)
    try {
      if (entry.quantity <= 1) {
        await removeStorefrontCartItem(token, entry.itemId)
      } else {
        await updateStorefrontCartItem(token, entry.itemId, entry.quantity - 1)
      }
      refreshCartCount()
      loadCartItems()
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.catalog.updateError'))
    } finally {
      setAddingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <InputGroup className="h-9">
          <InputGroupAddon>{searching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}</InputGroupAddon>
          <InputGroupInput placeholder={t('storefront.catalog.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </InputGroup>
        <Button variant="outline" size="lg" className="relative h-9 shrink-0" onClick={openFilters}>
          <SlidersHorizontalIcon />
          {t('storefront.filters.title')}
          {activeFilterCount > 0 && (
            <Badge variant="destructive" className="ml-0.5 h-4.5 min-w-4.5 justify-center rounded-full px-1 text-[10px]">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </div>

      {products === null ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[3/4] w-full" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t('storefront.catalog.empty')}</p>
      ) : (
        <div className={`grid grid-cols-2 gap-3 transition-opacity duration-200 sm:grid-cols-3 md:grid-cols-4 ${searching ? 'opacity-50' : 'opacity-100'}`}>
          {products.map((product) => {
            const outOfStock = product.available !== null && product.available <= 0
            const lowStock = product.available !== null && product.available > 0 && product.available <= LOW_STOCK_THRESHOLD
            const isAdding = addingId === product.id
            const cartEntry = cartItems.get(product.id)
            const inCartQty = product.has_variants
              ? (product.variants ?? []).reduce((sum, v) => sum + (cartItems.get(v.id)?.quantity ?? 0), 0)
              : (cartEntry?.quantity ?? 0)

            return (
              <div key={product.id} className="group animate-in fade-in-0 overflow-hidden rounded-xl border border-border bg-card transition-shadow duration-300 hover:shadow-md">
                <Link to={`/tienda/${slug}/producto/${product.id}`} className="block">
                  <div className="relative aspect-square w-full overflow-hidden bg-muted">
                    <StorefrontImage src={product.image_url} alt={product.name} className="h-full w-full transition-transform group-hover:scale-105" />
                    {outOfStock && (
                      <Badge variant="destructive" className="absolute top-2 left-2">
                        {t('storefront.catalog.outOfStock')}
                      </Badge>
                    )}
                    {!outOfStock && lowStock && (
                      <Badge variant="outline" className="absolute top-2 left-2 bg-background">
                        {t('storefront.catalog.lowStock', { count: product.available ?? 0 })}
                      </Badge>
                    )}
                  </div>
                  <div className="p-3 pb-0">
                    <p className="truncate text-sm font-medium text-foreground">{product.name}</p>
                    {product.brand_name && <p className="truncate text-xs text-muted-foreground">{product.brand_name}</p>}
                    <p className="mt-0.5 text-sm font-semibold text-primary">{formatCurrency(product.price)}</p>
                    {product.sku && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">SKU: {product.sku}</p>}
                  </div>
                </Link>
                <div className="p-3 pt-2">
                  {product.has_variants ? (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button size="sm" className="w-full justify-between" disabled={outOfStock}>
                          <span className="flex items-center gap-1.5">
                            <PlusIcon />
                            {outOfStock ? t('storefront.catalog.outOfStock') : t('storefront.catalog.chooseOption')}
                          </span>
                          {inCartQty > 0 && (
                            <Badge variant="secondary" className="h-4.5 min-w-4.5 justify-center rounded-full px-1 text-[10px]">
                              {inCartQty}
                            </Badge>
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-1.5" align="start">
                        {(product.variants ?? []).map((variant) => {
                          const variantOut = (variant.available ?? 0) <= 0
                          const variantEntry = cartItems.get(variant.id)
                          const variantBusy = addingId === variant.id
                          return (
                            <div key={variant.id} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-sm">
                              <span className="truncate">{variant.label}</span>
                              {variantEntry ? (
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={variantBusy}
                                    onClick={() => handleDecrement(variant.id)}
                                    className="flex size-6 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted disabled:opacity-40"
                                  >
                                    <MinusIcon className="size-3" />
                                  </button>
                                  <span className="w-4 text-center text-xs">{variantBusy ? <Loader2Icon className="mx-auto size-3 animate-spin" /> : variantEntry.quantity}</span>
                                  <button
                                    type="button"
                                    disabled={variantBusy || variantOut}
                                    onClick={() => handleQuickAdd(product, variant.id)}
                                    className="flex size-6 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted disabled:opacity-40"
                                  >
                                    <PlusIcon className="size-3" />
                                  </button>
                                </div>
                              ) : variantOut ? (
                                <span className="shrink-0 text-xs text-muted-foreground">{t('storefront.catalog.outOfStock')}</span>
                              ) : (
                                <button
                                  type="button"
                                  disabled={variantBusy}
                                  onClick={() => handleQuickAdd(product, variant.id)}
                                  className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted"
                                >
                                  {variantBusy ? <Loader2Icon className="size-3 animate-spin" /> : <PlusIcon className="size-3" />}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </PopoverContent>
                    </Popover>
                  ) : cartEntry ? (
                    <div className="flex h-7 items-center justify-between rounded-lg border border-border">
                      <button
                        type="button"
                        disabled={isAdding}
                        onClick={() => handleDecrement(product.id)}
                        className="flex h-full flex-1 items-center justify-center text-foreground hover:bg-muted disabled:opacity-40"
                        aria-label={t('storefront.catalog.decrease')}
                      >
                        <MinusIcon className="size-3.5" />
                      </button>
                      <span className="w-6 text-center text-sm font-medium text-foreground">
                        {isAdding ? <Loader2Icon className="mx-auto size-3.5 animate-spin" /> : cartEntry.quantity}
                      </span>
                      <button
                        type="button"
                        disabled={isAdding || outOfStock}
                        onClick={() => handleQuickAdd(product)}
                        className="flex h-full flex-1 items-center justify-center text-foreground hover:bg-muted disabled:opacity-40"
                        aria-label={t('storefront.catalog.increase')}
                      >
                        <PlusIcon className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <Button size="sm" className="w-full" disabled={outOfStock || isAdding} onClick={() => handleQuickAdd(product)}>
                      {isAdding ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
                      {outOfStock ? t('storefront.catalog.outOfStock') : t('storefront.product.addToCart')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="flex flex-col">
          <SheetHeader>
            <SheetTitle>{t('storefront.filters.title')}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 space-y-5 overflow-y-auto px-4">
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{t('storefront.filters.brand')}</p>
              <Select value={draftBrandId ?? ALL} onValueChange={(v) => setDraftBrandId(v === ALL ? null : v)}>
                <SelectTrigger className="h-9 w-full text-sm">
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
              <p className="text-sm font-medium text-foreground">{t('storefront.filters.category')}</p>
              <CategoryTreeFilter
                categories={categories}
                value={draftCategoryId}
                onChange={setDraftCategoryId}
                placeholder={t('storefront.filters.categoryPlaceholder')}
                searchPlaceholder={t('storefront.filters.categorySearchPlaceholder')}
                emptyLabel={t('storefront.filters.categoryEmpty')}
                rootLabel={t('storefront.filters.categoryRoot')}
                triggerClassName="w-full h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{t('storefront.filters.sort')}</p>
              <Select value={draftSort} onValueChange={(v) => setDraftSort(v as SortOption)}>
                <SelectTrigger className="h-9 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name_asc">{t('storefront.filters.sortNameAsc')}</SelectItem>
                  <SelectItem value="price_asc">{t('storefront.filters.sortPriceAsc')}</SelectItem>
                  <SelectItem value="price_desc">{t('storefront.filters.sortPriceDesc')}</SelectItem>
                  <SelectItem value="newest">{t('storefront.filters.sortNewest')}</SelectItem>
                </SelectContent>
              </Select>
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
