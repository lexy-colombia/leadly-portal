import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useLanguage } from '../../contexts/LanguageContext'
import { addToStorefrontCart, getStorefrontProduct, type StorefrontProductDetail as ProductDetailData } from '../../lib/api/storefront'
import { getStorefrontCartToken, setStorefrontCartToken } from '../../lib/storefrontCart'
import type { StorefrontOutletContext } from '../../layouts/StorefrontLayout'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

export function StorefrontProductDetail() {
  const { slug, refreshCartCount, showError } = useOutletContext<StorefrontOutletContext>()
  const { productId = '' } = useParams<{ productId: string }>()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [product, setProduct] = useState<ProductDetailData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [selectedImage, setSelectedImage] = useState(0)
  const [variantId, setVariantId] = useState<string>('')
  const [quantity, setQuantity] = useState(1)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    setProduct(null)
    setNotFound(false)
    setSelectedImage(0)
    setVariantId('')
    setQuantity(1)
    getStorefrontProduct(slug, productId)
      .then(setProduct)
      .catch(() => setNotFound(true))
  }, [slug, productId])

  if (notFound) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{t('storefront.product.notFound')}</p>
  }
  if (!product) {
    return (
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Skeleton className="aspect-square w-full" />
        <div className="space-y-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    )
  }

  const price = product.has_variants ? (product.variants.find((v) => v.id === variantId)?.price ?? product.price) : product.price
  const images = product.images.length > 0 ? product.images : [{ url: '', variant_id: null }]

  async function handleAddToCart() {
    if (!product) return
    if (product.has_variants && !variantId) {
      showError(t('storefront.product.variantRequired'))
      return
    }
    setAdding(true)
    try {
      const result = await addToStorefrontCart({
        slug,
        session_token: getStorefrontCartToken(slug),
        product_id: product.id,
        variant_id: variantId || undefined,
        quantity,
      })
      setStorefrontCartToken(slug, result.session_token)
      refreshCartCount(result.items)
      navigate(`/tienda/${slug}/carrito`)
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.product.addError'))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <div className="aspect-square w-full overflow-hidden rounded-xl border border-border bg-muted">
          <StorefrontImage src={images[selectedImage]?.url || null} alt={product.name} className="h-full w-full" iconClassName="size-8" fit="contain" />
        </div>
        {images.length > 1 && (
          <div className="mt-3 flex gap-2">
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
      </div>

      <div>
        {product.categories.length > 0 && <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{product.categories.join(' · ')}</p>}
        <h1 className="mt-1 text-xl font-bold text-foreground">{product.name}</h1>
        <p className="mt-2 text-2xl font-bold text-primary">{formatCurrency(price)}</p>
        {product.description && <p className="mt-3 text-sm text-muted-foreground">{product.description}</p>}

        {product.has_variants && (
          <div className="mt-4 space-y-1.5">
            <p className="text-sm font-medium text-foreground">{t('storefront.product.variant')}</p>
            <div className="flex flex-wrap gap-2">
              {product.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariantId(v.id)}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${v.id === variantId ? 'border-primary bg-primary/5 text-primary' : 'border-border text-foreground hover:bg-muted'}`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <p className="text-sm font-medium text-foreground">{t('storefront.product.quantity')}</p>
          <div className="flex items-center rounded-lg border border-border">
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="px-3 py-1.5 text-foreground hover:bg-muted">
              −
            </button>
            <span className="w-8 text-center text-sm font-medium text-foreground">{quantity}</span>
            <button type="button" onClick={() => setQuantity((q) => q + 1)} className="px-3 py-1.5 text-foreground hover:bg-muted">
              +
            </button>
          </div>
        </div>

        <Button size="lg" className="mt-5 w-full" onClick={handleAddToCart} disabled={adding}>
          {adding ? t('common.actions.saving') : t('storefront.product.addToCart')}
        </Button>
      </div>
    </div>
  )
}
