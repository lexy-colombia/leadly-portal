import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Loader2Icon, SearchIcon, ShoppingCartIcon } from 'lucide-react'
import { useLanguage } from '../contexts/LanguageContext'
import { getStorefront, getStorefrontCart, type StorefrontCartItem, type StorefrontInfo } from '../lib/api/storefront'
import { getStorefrontCartToken } from '../lib/storefrontCart'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

export interface StorefrontOutletContext {
  slug: string
  tenant: StorefrontInfo
  /** Recalcula el badge del carrito en el header -- las páginas hijas la
   * llaman después de cualquier mutación (agregar/editar/quitar ítems). Toda
   * mutación del carrito (add/update/remove_cart_item) ya devuelve el arreglo
   * `items` actualizado en su propia respuesta -- pasarlo acá evita un
   * get_cart de más por click, que era la causa real de la lentitud
   * percibida al agregar un producto (dos round-trips a la Edge Function en
   * vez de uno). Sin argumento, cae al fetch de red (solo hace falta al
   * montar el layout, cuando todavía no hay ninguna respuesta de mutación).
   * También acepta un número directo -- el catálogo, al agregar varios
   * productos distintos en paralelo, ya no puede pasar "el items completo"
   * de una sola respuesta (cada respuesta de add_to_cart solo refleja ESE
   * producto de forma confiable bajo clicks concurrentes, ver
   * StorefrontCatalog.tsx) y en su lugar manda el total ya recalculado de su
   * propio estado local combinado. */
  refreshCartCount: (items?: StorefrontCartItem[] | number) => void
  /** Todos los errores de la tienda se muestran en un modal (pedido
   * explícito del usuario) en vez de texto inline -- una sola instancia acá
   * arriba, las páginas hijas solo la invocan. */
  showError: (message: string) => void
  /** El buscador vive en el header (visible en toda la tienda, no solo en el
   * catálogo) -- el estado se guarda acá arriba para que el input sobreviva
   * la navegación entre catálogo/detalle/carrito. StorefrontCatalog es quien
   * efectivamente filtra con esto y reporta si hay una consulta en vuelo
   * (`setSearching`) para que el header muestre el ícono girando. */
  search: string
  setSearch: (value: string) => void
  searching: boolean
  setSearching: (value: boolean) => void
}

/** Layout propio y liviano para la tienda pública (marketplace) -- ruta sin
 * autenticación, hermana de /login en App.tsx, así que no usa TenantLayout
 * (que asume una sesión y un AuthContext con perfil). Resuelve el tenant por
 * slug una sola vez acá y lo pasa a las 3 sub-páginas vía outlet context, en
 * vez de que cada una repita la misma llamada. */
export function StorefrontLayout() {
  const { slug = '' } = useParams<{ slug: string }>()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const [tenant, setTenant] = useState<StorefrontInfo | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)
  const [cartCount, setCartCount] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [search, setSearchState] = useState('')
  const [searching, setSearching] = useState(false)

  // Escribir en el buscador desde cualquier página que no sea el catálogo
  // (detalle de producto, carrito) lleva de vuelta ahí para ver resultados --
  // el catálogo es el único que sabe filtrar con esto, no tiene sentido
  // dejar el texto tipeado sin ningún lugar donde aplicarse.
  const catalogPath = `/tienda/${slug}`
  const setSearch = useCallback(
    (value: string) => {
      setSearchState(value)
      if (location.pathname !== catalogPath) navigate(catalogPath)
    },
    [catalogPath, location.pathname, navigate],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    getStorefront(slug)
      .then((info) => {
        if (!cancelled) setTenant(info)
      })
      .catch(() => {
        if (!cancelled) setNotFound(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  const refreshCartCount = useCallback(
    (items?: StorefrontCartItem[] | number) => {
      if (typeof items === 'number') {
        setCartCount(items)
        return
      }
      if (items) {
        setCartCount(items.reduce((sum, item) => sum + item.quantity, 0))
        return
      }
      const token = getStorefrontCartToken(slug)
      if (!token) {
        setCartCount(0)
        return
      }
      getStorefrontCart(token)
        .then((res) => setCartCount(res.items.reduce((sum, item) => sum + item.quantity, 0)))
        .catch(() => setCartCount(0))
    },
    [slug],
  )

  useEffect(() => {
    refreshCartCount()
  }, [refreshCartCount])

  const showError = useCallback((message: string) => setErrorMessage(message), [])

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <Skeleton className="h-9 w-40" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (notFound || !tenant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="text-center">
          <p className="text-base font-semibold text-foreground">{t('storefront.notFound.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('storefront.notFound.description')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link to={`/tienda/${slug}`} className="flex min-w-0 shrink-0 items-center gap-2.5">
            {tenant.logo_url ? (
              <img src={tenant.logo_url} alt={tenant.name} className="h-9 w-9 shrink-0 rounded-full object-cover" />
            ) : (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                {tenant.name.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="hidden truncate text-base font-bold text-foreground sm:inline">{tenant.name}</span>
          </Link>
          <InputGroup className="mx-auto hidden h-9 max-w-md sm:flex">
            <InputGroupAddon>{searching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}</InputGroupAddon>
            <InputGroupInput placeholder={t('storefront.header.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </InputGroup>
          <Button asChild variant="outline" className="relative ml-auto shrink-0 gap-2 rounded-full">
            <Link to={`/tienda/${slug}/carrito`} aria-label={t('storefront.header.cart')}>
              <ShoppingCartIcon className="size-4" />
              <span className="hidden sm:inline">{t('storefront.header.cart')}</span>
              {cartCount > 0 && (
                <Badge variant="destructive" className="h-4.5 min-w-4.5 justify-center rounded-full px-1 text-[10px]">
                  {cartCount > 99 ? '99+' : cartCount}
                </Badge>
              )}
            </Link>
          </Button>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3 sm:hidden">
          <InputGroup className="h-9">
            <InputGroupAddon>{searching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}</InputGroupAddon>
            <InputGroupInput placeholder={t('storefront.header.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </InputGroup>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet context={{ slug, tenant, refreshCartCount, showError, search, setSearch, searching, setSearching } satisfies StorefrontOutletContext} />
      </main>

      <Dialog open={!!errorMessage} onOpenChange={(open) => !open && setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('storefront.error.title')}</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setErrorMessage(null)}>{t('storefront.error.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
