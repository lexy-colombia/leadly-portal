import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import { useLanguage } from '../../contexts/LanguageContext'
import { getStorefrontProduct, listStorefrontProducts, type StorefrontProductDetail as ProductDetailData, type StorefrontProductSummary } from '../../lib/api/storefront'
import { useStorefrontCart } from '../../lib/useStorefrontCart'
import type { StorefrontOutletContext } from '../../layouts/StorefrontLayout'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'
import { StorefrontOrderPanel } from '@/components/storefront/StorefrontOrderPanel'
import { ProductCard, StockStatus } from '@/components/storefront/ProductCard'

const RELATED_LIMIT = 7

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

/** Detalle de producto de la tienda pública -- rediseñado a partir de un
 * mockup de referencia del usuario (3 columnas: imágenes | info | "Tu
 * pedido", igual que un checkout de e-commerce real). A diferencia de la
 * versión anterior (que agregaba al carrito y navegaba directo a /carrito),
 * ahora el visitante se queda en la página: el panel derecho es el mismo
 * StorefrontOrderPanel que ya usa StorefrontCatalog, alimentado por el mismo
 * hook useStorefrontCart -- agregar acá y seguir viendo el catálogo/otros
 * productos actualiza el mismo carrito en vivo, sin round-trips extra. */
export function StorefrontProductDetail() {
  const { slug, refreshCartCount, showError } = useOutletContext<StorefrontOutletContext>()
  const { productId = '' } = useParams<{ productId: string }>()
  const { t } = useLanguage()
  const [product, setProduct] = useState<ProductDetailData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [selectedImage, setSelectedImage] = useState(0)
  const [variantId, setVariantId] = useState<string>('')
  const [quantity, setQuantity] = useState(1)
  const [adding, setAdding] = useState(false)
  const [justAdded, setJustAdded] = useState(false)
  const [related, setRelated] = useState<StorefrontProductSummary[] | null>(null)
  const justAddedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cart = useStorefrontCart(slug, refreshCartCount, (err) => showError(err instanceof Error ? err.message : t('storefront.product.addError')))

  useEffect(() => {
    setProduct(null)
    setNotFound(false)
    setSelectedImage(0)
    setVariantId('')
    setQuantity(1)
    setRelated(null)
    getStorefrontProduct(slug, productId)
      .then(setProduct)
      .catch(() => setNotFound(true))
  }, [slug, productId])

  // Productos de la(s) misma(s) categoría(s) del producto actual -- se pide
  // RELATED_LIMIT+1 y se recorta a 6 después de sacar el producto actual
  // (el backend no soporta excluir un id, ver comentario en list_products),
  // así siempre quedan hasta 6 aunque el propio producto caiga en el rango.
  useEffect(() => {
    if (!product || product.category_ids.length === 0) {
      setRelated([])
      return
    }
    let cancelled = false
    listStorefrontProducts(slug, { category_ids: product.category_ids, limit: RELATED_LIMIT })
      .then((res) => {
        if (cancelled) return
        setRelated(res.products.filter((p) => p.id !== product.id).slice(0, RELATED_LIMIT - 1))
      })
      .catch(() => {
        if (!cancelled) setRelated([])
      })
    return () => {
      cancelled = true
    }
  }, [slug, product])

  useEffect(() => () => {
    if (justAddedTimer.current) clearTimeout(justAddedTimer.current)
  }, [])

  if (notFound) {
    return <p className="py-10 text-center text-xs text-muted-foreground">{t('storefront.product.notFound')}</p>
  }
  if (!product) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px]">
        <Skeleton className="aspect-square w-full" />
        <div className="space-y-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="hidden h-64 w-full lg:block" />
      </div>
    )
  }

  const selectedVariant = product.variants.find((v) => v.id === variantId)
  const price = product.has_variants ? (selectedVariant?.price ?? product.price) : product.price
  const images = product.images.length > 0 ? product.images : [{ url: '', variant_id: null }]
  const available = product.has_variants ? (selectedVariant ? (selectedVariant.available ?? 0) : null) : product.available
  const outOfStock = available !== null && available <= 0
  const lowStock = available !== null && available > 0 && available <= 5

  async function handleAddToCart() {
    if (!product) return
    if (product.has_variants && !variantId) {
      showError(t('storefront.product.variantRequired'))
      return
    }
    const key = product.has_variants ? variantId : product.id
    const current = cart.itemsByKey.get(key)?.quantity ?? 0
    setAdding(true)
    const ok = await cart.commitCartQuantity(key, product.id, product.has_variants ? variantId : undefined, current + quantity)
    setAdding(false)
    if (ok) {
      setJustAdded(true)
      if (justAddedTimer.current) clearTimeout(justAddedTimer.current)
      justAddedTimer.current = setTimeout(() => setJustAdded(false), 1200)
    }
  }

  return (
    <div className="space-y-8">
      <nav className="text-xs text-muted-foreground">
        <Link to={`/tienda/${slug}`} className="hover:text-foreground hover:underline">
          {t('storefront.breadcrumb.home')}
        </Link>
        {product.categories.map((category) => (
          <span key={category}>
            <span> / </span>
            <span>{category}</span>
          </span>
        ))}
        <span> / </span>
        <span className="text-foreground">{product.name}</span>
      </nav>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px]">
        <div className="flex gap-3">
          {images.length > 1 && (
            <div className="flex shrink-0 flex-col gap-2">
              {images.map((img, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelectedImage(i)}
                  className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border ${i === selectedImage ? 'border-primary' : 'border-border'}`}
                >
                  <StorefrontImage src={img.url || null} alt="" className="h-full w-full" />
                </button>
              ))}
            </div>
          )}
          <div className="aspect-square w-full flex-1 overflow-hidden rounded-xl border border-border bg-muted">
            <StorefrontImage src={images[selectedImage]?.url || null} alt={product.name} className="h-full w-full" iconClassName="size-8" fit="contain" />
          </div>
        </div>

        <div>
          {product.brand_name && <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{product.brand_name}</p>}
          <h1 className="mt-1 text-base font-bold text-foreground">{product.name}</h1>
          {product.sku && <p className="mt-0.5 text-xs text-muted-foreground">{t('storefront.product.sku', { sku: product.sku })}</p>}
          <p className="mt-2 text-lg font-bold text-primary">{formatCurrency(price)}</p>
          {product.description && <p className="mt-3 text-xs text-muted-foreground">{product.description}</p>}

          {product.has_variants && (
            <div className="mt-4 space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t('storefront.product.variant')}</p>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVariantId(v.id)}
                    className={`rounded-lg border px-3 py-1.5 text-xs ${v.id === variantId ? 'border-primary bg-primary/5 text-primary' : 'border-border text-foreground hover:bg-muted'}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {available !== null && <StockStatus outOfStock={outOfStock} lowStock={lowStock} available={available} className="mt-4" />}

          <div className="mt-4 flex items-center gap-3">
            <p className="text-xs font-medium text-foreground">{t('storefront.product.quantity')}</p>
            <div className="flex items-center rounded-lg border border-border">
              <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="px-3 py-1.5 text-foreground hover:bg-muted">
                −
              </button>
              <span className="w-8 text-center text-xs font-medium text-foreground">{quantity}</span>
              <button type="button" onClick={() => setQuantity((q) => q + 1)} className="px-3 py-1.5 text-foreground hover:bg-muted">
                +
              </button>
            </div>
          </div>

          <Button size="lg" className="mt-5 w-full" onClick={handleAddToCart} disabled={adding || outOfStock}>
            {adding ? t('common.actions.saving') : justAdded ? `${t('storefront.product.added')} ✓` : outOfStock ? t('storefront.catalog.outOfStock') : t('storefront.product.addToCart')}
          </Button>

          <Tabs defaultValue="description" className="mt-8">
            <TabsList variant="line" className="w-full justify-start border-b border-border">
              <TabsTrigger value="description">{t('storefront.product.descriptionTab')}</TabsTrigger>
              <TabsTrigger value="specs">{t('storefront.product.specsTab')}</TabsTrigger>
            </TabsList>
            <TabsContent value="description" className="pt-3 text-xs text-muted-foreground">
              {product.description || t('storefront.product.noDescription')}
            </TabsContent>
            <TabsContent value="specs" className="pt-3">
              <dl className="space-y-2 text-xs">
                {product.sku && (
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted-foreground">{t('storefront.product.specsSku')}</dt>
                    <dd className="text-foreground">{product.sku}</dd>
                  </div>
                )}
                {product.brand_name && (
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted-foreground">{t('storefront.product.specsBrand')}</dt>
                    <dd className="text-foreground">{product.brand_name}</dd>
                  </div>
                )}
                {product.categories.length > 0 && (
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted-foreground">{t('storefront.product.specsCategories')}</dt>
                    <dd className="text-foreground">{product.categories.join(', ')}</dd>
                  </div>
                )}
                {product.has_variants && (
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 text-muted-foreground">{t('storefront.product.specsVariants')}</dt>
                    <dd className="text-foreground">{product.variants.map((v) => v.label).join(', ')}</dd>
                  </div>
                )}
              </dl>
            </TabsContent>
          </Tabs>
        </div>

        <aside className="hidden lg:block">
          <StorefrontOrderPanel slug={slug} items={cart.items} totals={cart.totals} onCommit={cart.commitPanelQuantity} onClear={cart.handleCartCleared} onError={showError} />
        </aside>
      </div>

      {related !== null && related.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-foreground">{t('storefront.product.related')}</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {related.map((relatedProduct) => (
              <ProductCard
                key={relatedProduct.id}
                slug={slug}
                product={relatedProduct}
                getCartQuantity={(key) => cart.itemsByKey.get(key)?.quantity ?? 0}
                onCommit={(key, variantIdArg, qty) => cart.commitCartQuantity(key, relatedProduct.id, variantIdArg, qty)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
