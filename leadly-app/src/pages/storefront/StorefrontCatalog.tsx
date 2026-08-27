import { useCallback, useEffect, useRef, useState } from 'react'
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
  type StorefrontCartItem,
  type StorefrontProductSummary,
  type StorefrontProductVariant,
} from '../../lib/api/storefront'
import { descendantIds } from '../../lib/api/productCategories'
import { getStorefrontCartToken, setStorefrontCartToken } from '../../lib/storefrontCart'
import { useDebouncedQuantity } from '../../lib/useDebouncedQuantity'
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
// Scroll infinito -- pedido explícito del usuario: la carga inicial completa
// del catálogo (hasta 120 productos con imagen, marca, stock y variantes de
// cada uno) se sentía pesada. De a PAGE_SIZE en vez de todo de una.
const PAGE_SIZE = 20

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
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // Cuántos productos ya se cargaron para esta combinación de filtros --
  // ref porque loadMore (disparado por el IntersectionObserver) necesita el
  // valor más reciente sin quedar atado a un closure viejo, y no hace falta
  // re-renderizar solo porque cambió.
  const offsetRef = useRef(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
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

  // product_id (simples) o variant_id (con variantes) -> ítem real del
  // carrito -- pedido explícito: "no se cual ya agregué, no es claro eso" +
  // "si algo ya está agregado, quita el botón de agregar y poné ahí el
  // indicador de cantidades para poder modificarlas". Guarda el itemId (no
  // solo la cantidad) porque modificar/quitar necesita ese id, no el
  // product_id/variant_id.
  const [cartItems, setCartItems] = useState<Map<string, { itemId: string; quantity: number }>>(new Map())
  // Espejo síncrono de `cartItems` -- `commitCartQuantity` lo necesita para
  // leer/actualizar el mapa sin quedar atado al closure (posiblemente viejo)
  // de cuándo se disparó el commit. Ver el comentario de esa función: dos
  // productos distintos agregándose en paralelo (bug real reportado) sino
  // cada respuesta que llega tarde pisaba TODO el mapa con su propia foto
  // parcial, borrando lo que la otra request ya había agregado.
  const cartItemsRef = useRef<Map<string, { itemId: string; quantity: number }>>(new Map())
  // Cuando todavía no existe ningún carrito (primera visita, sin token en
  // localStorage), el PRIMER add_to_cart que sale es el que efectivamente lo
  // crea -- si dos productos distintos se agregan casi al mismo tiempo antes
  // de que ese primer request vuelva con un session_token, los dos mandan
  // session_token=null en paralelo y el backend, sin forma de saber que es
  // el mismo visitante, crea DOS carritos separados (uno por producto). El
  // segundo queda huérfano en cuanto el primero graba su token en
  // localStorage -- bug real reportado como "se pierden productos al
  // refrescar" (el que sobrevive en localStorage es el de un solo
  // producto). Este ref es la promesa del primer add en vuelo: cualquier
  // otro commit que también encuentre el token vacío espera ESTE resultado
  // en vez de disparar su propio carrito nuevo.
  const pendingCartTokenRef = useRef<Promise<string> | null>(null)

  const applyCartItems = useCallback((items: StorefrontCartItem[]) => {
    const map = new Map<string, { itemId: string; quantity: number }>()
    for (const item of items) {
      const key = item.variant_id ?? item.product_id
      const existing = map.get(key)
      map.set(key, { itemId: item.id, quantity: (existing?.quantity ?? 0) + item.quantity })
    }
    cartItemsRef.current = map
    setCartItems(map)
  }, [])

  // Solo al montar/cambiar de tienda -- después de cada mutación (agregar/
  // quitar) el propio `items` que devuelve esa llamada alcanza para
  // actualizar el estado local, sin otro round-trip a get_cart (ver
  // commitCartQuantity). Antes se llamaba a esto también después
  // de cada click, duplicando la latencia percibida de "agregar al carrito".
  useEffect(() => {
    const token = getStorefrontCartToken(slug)
    if (!token) {
      cartItemsRef.current = new Map()
      setCartItems(new Map())
      return
    }
    getStorefrontCart(token)
      .then((res) => applyCartItems(res.items))
      .catch(() => {
        cartItemsRef.current = new Map()
        setCartItems(new Map())
      })
  }, [slug, applyCartItems])

  useEffect(() => {
    listStorefrontCategories(slug)
      .then((res) => setCategories(res.categories))
      .catch(() => setCategories([]))
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
        sort: appliedSort,
        offset: 0,
        limit: PAGE_SIZE,
      })
        .then((res) => {
          if (cancelled) return
          setProducts(res.products)
          setHasMore(res.has_more)
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
  }, [slug, search, appliedCategoryId, appliedBrandId, appliedSort, categories])

  const loadMore = useCallback(() => {
    if (loadingMore || searching || !hasMore) return
    const categoryIds = appliedCategoryId ? [appliedCategoryId, ...descendantIds(categories, appliedCategoryId)] : undefined
    setLoadingMore(true)
    listStorefrontProducts(slug, {
      search: search || undefined,
      category_ids: categoryIds,
      brand_id: appliedBrandId || undefined,
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
  }, [slug, search, appliedCategoryId, appliedBrandId, appliedSort, categories, hasMore, loadingMore, searching])

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

  // Único punto de guardado real para la cantidad de un producto/variante en
  // el carrito -- lo llaman ProductCardAction/VariantRow ya debounced (ver
  // useDebouncedQuantity), con el valor absoluto final que el usuario dejó
  // después de parar de clickear/tipear, nunca uno por click. Decide
  // add_to_cart (todavía no había ítem) vs update/remove_cart_item (ya
  // había uno, con su propio itemId) mirando `cartItems` en el momento en
  // que el debounce efectivamente dispara, no en el momento del primer
  // click.
  async function commitCartQuantity(key: string, product: StorefrontProductSummary, variantId: string | undefined, quantity: number) {
    const entry = cartItemsRef.current.get(key)
    try {
      let freshItems: StorefrontCartItem[]
      if (entry) {
        const token = getStorefrontCartToken(slug)
        if (!token) return
        const res = quantity <= 0 ? await removeStorefrontCartItem(token, entry.itemId) : await updateStorefrontCartItem(token, entry.itemId, quantity)
        freshItems = res.items
      } else if (quantity > 0) {
        let sessionToken = getStorefrontCartToken(slug)
        // Si no hay token todavía pero YA hay un primer add en vuelo
        // creando el carrito, esperar ese resultado en vez de mandar
        // session_token=null también -- ver el comentario de
        // pendingCartTokenRef arriba.
        if (!sessionToken && pendingCartTokenRef.current) {
          sessionToken = await pendingCartTokenRef.current
        }
        const addPromise = addToStorefrontCart({ slug, session_token: sessionToken, product_id: product.id, variant_id: variantId, quantity }).then((result) => {
          setStorefrontCartToken(slug, result.session_token)
          return result
        })
        if (!sessionToken) {
          const tokenPromise = addPromise.then((result) => result.session_token)
          pendingCartTokenRef.current = tokenPromise
          tokenPromise.finally(() => {
            if (pendingCartTokenRef.current === tokenPromise) pendingCartTokenRef.current = null
          })
        }
        const result = await addPromise
        freshItems = result.items
      } else {
        return
      }

      // Actualiza SOLO la entrada de `key` sobre el mapa más reciente (el
      // ref, no el `cartItems` capturado cuando arrancó este commit) --
      // nunca reemplaza el mapa entero con `freshItems`, que es apenas la
      // foto del carrito según ESTA respuesta puntual. Bug real reportado:
      // agregar 2 productos distintos rápido disparaba 2 add_to_cart en
      // paralelo, y cualquiera de las dos respuestas que llegara última
      // pisaba por completo el estado local -- incluida la entrada del OTRO
      // producto, que a veces ni siquiera aparecía todavía en esa respuesta
      // puntual aunque ya estuviera guardado en la base. Tocar una sola
      // clave por commit hace que el orden de llegada de las respuestas ya
      // no importe.
      const match = freshItems.find((item) => (item.variant_id ?? item.product_id) === key)
      const next = new Map(cartItemsRef.current)
      if (match) next.set(key, { itemId: match.id, quantity: match.quantity })
      else next.delete(key)
      cartItemsRef.current = next
      setCartItems(next)
      refreshCartCount(Array.from(next.values()).reduce((sum, v) => sum + v.quantity, 0))
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.catalog.updateError'))
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
                        {(product.variants ?? []).map((variant) => (
                          <VariantRow
                            key={variant.id}
                            variant={variant}
                            cartQuantity={cartItems.get(variant.id)?.quantity ?? 0}
                            outOfStockLabel={t('storefront.catalog.outOfStock')}
                            onCommit={(quantity) => commitCartQuantity(variant.id, product, variant.id, quantity)}
                          />
                        ))}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <ProductCardAction
                      cartQuantity={cartEntry?.quantity ?? 0}
                      outOfStock={outOfStock}
                      addLabel={t('storefront.product.addToCart')}
                      outOfStockLabel={t('storefront.catalog.outOfStock')}
                      decreaseLabel={t('storefront.catalog.decrease')}
                      increaseLabel={t('storefront.catalog.increase')}
                      onCommit={(quantity) => commitCartQuantity(product.id, product, undefined, quantity)}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {products !== null && products.length > 0 && (hasMore || loadingMore) && (
        <div ref={sentinelRef} className="flex justify-center py-4">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
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

/** Botón "Agregar" (o "Elegir opción" que en realidad es el trigger del
 * Popover, este componente es solo el caso sin variantes) que se convierte
 * en un stepper -/input/+ -- dueño de su propio useDebouncedQuantity, así
 * que el cambio de "Agregar" a stepper es instantáneo (según el valor LOCAL,
 * no hace falta esperar la confirmación del servidor) apenas se toca +. El
 * número se puede tipear directo, no solo +/-, y el borde + el ícono girando
 * en la esquina avisan que hay un cambio guardándose, sin deshabilitar los
 * botones mientras tanto (a diferencia de antes, que bloqueaba el próximo
 * click hasta que el anterior terminara de viajar). */
function ProductCardAction({
  cartQuantity,
  outOfStock,
  addLabel,
  outOfStockLabel,
  decreaseLabel,
  increaseLabel,
  onCommit,
}: {
  cartQuantity: number
  outOfStock: boolean
  addLabel: string
  outOfStockLabel: string
  decreaseLabel: string
  increaseLabel: string
  onCommit: (quantity: number) => Promise<void>
}) {
  const { value, saving, setValue, nudge } = useDebouncedQuantity(cartQuantity, onCommit)

  if (value <= 0) {
    return (
      <Button size="sm" className="w-full" disabled={outOfStock} onClick={() => nudge(1)}>
        <PlusIcon />
        {outOfStock ? outOfStockLabel : addLabel}
      </Button>
    )
  }

  return (
    <div className={`relative flex h-7 items-center justify-between rounded-lg border transition-colors ${saving ? 'border-primary/60' : 'border-border'}`}>
      <button type="button" onClick={() => nudge(-1)} className="flex h-full flex-1 items-center justify-center text-foreground hover:bg-muted" aria-label={decreaseLabel}>
        <MinusIcon className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-8 border-0 bg-transparent text-center text-sm font-medium text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        disabled={outOfStock}
        onClick={() => nudge(1)}
        className="flex h-full flex-1 items-center justify-center text-foreground hover:bg-muted disabled:opacity-40"
        aria-label={increaseLabel}
      >
        <PlusIcon className="size-3.5" />
      </button>
      {saving && (
        <span className="absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-background">
          <Loader2Icon className="size-3 animate-spin text-primary" />
        </span>
      )}
    </div>
  )
}

/** Misma idea que ProductCardAction pero para una fila de variante dentro
 * del popover -- más compacta, y "Agotado" reemplaza el botón de agregar en
 * vez de deshabilitarlo cuando esa variante puntual no tiene stock. */
function VariantRow({
  variant,
  cartQuantity,
  outOfStockLabel,
  onCommit,
}: {
  variant: StorefrontProductVariant
  cartQuantity: number
  outOfStockLabel: string
  onCommit: (quantity: number) => Promise<void>
}) {
  const variantOut = (variant.available ?? 0) <= 0
  const { value, saving, nudge } = useDebouncedQuantity(cartQuantity, onCommit)

  return (
    <div className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-sm">
      <span className="truncate">{variant.label}</span>
      {value > 0 ? (
        <div className="relative flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => nudge(-1)}
            className={`flex size-6 items-center justify-center rounded-md border text-foreground hover:bg-muted ${saving ? 'border-primary/60' : 'border-border'}`}
          >
            <MinusIcon className="size-3" />
          </button>
          <span className="w-4 text-center text-xs">{value}</span>
          <button
            type="button"
            disabled={variantOut}
            onClick={() => nudge(1)}
            className={`flex size-6 items-center justify-center rounded-md border text-foreground hover:bg-muted disabled:opacity-40 ${saving ? 'border-primary/60' : 'border-border'}`}
          >
            <PlusIcon className="size-3" />
          </button>
          {saving && (
            <span className="absolute -top-1 -right-1 flex size-3 items-center justify-center rounded-full bg-background">
              <Loader2Icon className="size-2.5 animate-spin text-primary" />
            </span>
          )}
        </div>
      ) : variantOut ? (
        <span className="shrink-0 text-xs text-muted-foreground">{outOfStockLabel}</span>
      ) : (
        <button
          type="button"
          onClick={() => nudge(1)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted"
        >
          <PlusIcon className="size-3" />
        </button>
      )}
    </div>
  )
}
