import { Link } from 'react-router-dom'
import { Loader2Icon, MinusIcon, PlusIcon } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { useDebouncedQuantity } from '@/lib/useDebouncedQuantity'
import type { StorefrontProductSummary, StorefrontProductVariant } from '@/lib/api/storefront'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'

const LOW_STOCK_THRESHOLD = 5

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

/** Card de producto de la tienda pública -- extraída de StorefrontCatalog.tsx
 * para reusarla tal cual en la grilla de "también te puede interesar" del
 * detalle de producto (StorefrontProductDetail.tsx), sin duplicar el manejo
 * de variantes/stock/carrito. `getCartQuantity` resuelve cuánto hay ya en el
 * carrito para un product_id o variant_id dado (key), y `onCommit` guarda la
 * cantidad absoluta final -- ambos delegados al caller (useStorefrontCart),
 * que puede ser un carrito distinto según la página. */
export function ProductCard({
  slug,
  product,
  getCartQuantity,
  onCommit,
}: {
  slug: string
  product: StorefrontProductSummary
  getCartQuantity: (key: string) => number
  onCommit: (key: string, variantId: string | undefined, quantity: number) => Promise<unknown>
}) {
  const { t } = useLanguage()
  const outOfStock = product.available !== null && product.available <= 0
  const lowStock = product.available !== null && product.available > 0 && product.available <= LOW_STOCK_THRESHOLD
  const cartQuantity = getCartQuantity(product.id)
  const inCartQty = product.has_variants ? (product.variants ?? []).reduce((sum, v) => sum + getCartQuantity(v.id), 0) : cartQuantity

  return (
    <div className="group animate-in fade-in-0 overflow-hidden rounded-xl border border-border bg-card transition-shadow duration-300 hover:shadow-md">
      <Link to={`/tienda/${slug}/producto/${product.slug ?? product.id}`} className="block">
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          <StorefrontImage src={product.image_url} alt={product.name} className="h-full w-full transition-transform group-hover:scale-105" />
        </div>
        <div className="p-3 pb-0">
          {product.brand_name && <p className="truncate text-[11px] text-muted-foreground">{product.brand_name}</p>}
          <p className="truncate text-xs font-medium text-foreground">{product.name}</p>
          <p className="mt-0.5 text-sm font-semibold text-foreground">{formatCurrency(product.price)}</p>
          <StockStatus outOfStock={outOfStock} lowStock={lowStock} available={product.available} />
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
                  cartQuantity={getCartQuantity(variant.id)}
                  outOfStockLabel={t('storefront.catalog.outOfStock')}
                  onCommit={(quantity) => onCommit(variant.id, variant.id, quantity)}
                />
              ))}
            </PopoverContent>
          </Popover>
        ) : (
          <ProductCardAction
            cartQuantity={cartQuantity}
            outOfStock={outOfStock}
            addLabel={t('storefront.product.addToCart')}
            outOfStockLabel={t('storefront.catalog.outOfStock')}
            decreaseLabel={t('storefront.catalog.decrease')}
            increaseLabel={t('storefront.catalog.increase')}
            onCommit={(quantity) => onCommit(product.id, undefined, quantity)}
          />
        )}
      </div>
    </div>
  )
}

/** Línea de estado de stock -- punto de color + texto, siempre presente (no
 * solo cuando hay un problema). `available: null` (tenant sin
 * track_inventory) se trata como "siempre disponible". Exportada aparte para
 * que el detalle de producto (StorefrontProductDetail.tsx) la reuse también
 * fuera de una card, junto al precio principal. */
export function StockStatus({ outOfStock, lowStock, available, className }: { outOfStock: boolean; lowStock: boolean; available: number | null; className?: string }) {
  const { t } = useLanguage()
  const color = outOfStock ? 'bg-destructive' : lowStock ? 'bg-amber-500' : 'bg-emerald-500'
  const label = outOfStock ? t('storefront.catalog.outOfStock') : lowStock ? t('storefront.catalog.lowStock', { count: available ?? 0 }) : t('storefront.catalog.inStock')

  return (
    <p className={`flex items-center gap-1.5 text-[11px] text-muted-foreground ${className ?? 'mt-1'}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${color}`} />
      {label}
    </p>
  )
}

/** Botón "Agregar" (o "Elegir opción", el trigger del Popover -- este
 * componente es solo el caso sin variantes) que se convierte en un stepper
 * -/input/+ apenas se toca +, con guardado debounced propio. */
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
  onCommit: (quantity: number) => Promise<unknown>
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
        className="w-8 border-0 bg-transparent text-center text-xs font-medium text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
  onCommit: (quantity: number) => Promise<unknown>
}) {
  const variantOut = (variant.available ?? 0) <= 0
  const { value, saving, nudge } = useDebouncedQuantity(cartQuantity, onCommit)

  return (
    <div className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-xs">
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
