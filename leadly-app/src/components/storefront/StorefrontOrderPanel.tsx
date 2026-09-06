import { Link } from 'react-router-dom'
import { Loader2Icon, TrashIcon } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { useDebouncedQuantity } from '@/lib/useDebouncedQuantity'
import { getStorefrontCartToken } from '@/lib/storefrontCart'
import type { StorefrontCartItem } from '@/lib/api/storefront'
import type { OrderTotalsBreakdown } from '@/lib/api/orders'
import { Button } from '@/components/ui/button'
import { OrderTotalsSummary } from '@/components/molecules/OrderTotalsSummary'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'
import { ClearCartButton } from '@/components/storefront/ClearCartButton'

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

/** Panel de pedido siempre visible al lado del catálogo (desktop) -- pedido
 * explícito del usuario de fusionar catálogo + carrito en una sola pantalla,
 * en vez del ícono con badge que antes llevaba a /carrito como única forma
 * de ver qué había en el carrito. El checkout en sí (OTP, direcciones) sigue
 * viviendo en /carrito -- son varios pasos de formulario que no entran en
 * una barra lateral, "Continuar compra" solo navega para completarlos ahí.
 * En mobile este panel se oculta (ver el `hidden lg:flex` del caller) y el
 * ícono del header sigue siendo la única entrada al carrito, igual que
 * antes. */
export function StorefrontOrderPanel({
  slug,
  items,
  totals,
  onCommit,
  onClear,
  onError,
}: {
  slug: string
  items: StorefrontCartItem[]
  totals: OrderTotalsBreakdown | null
  onCommit: (itemId: string, quantity: number) => Promise<void>
  onClear: (result: { items: StorefrontCartItem[]; totals: OrderTotalsBreakdown }) => void
  onError: (message: string) => void
}) {
  const { t } = useLanguage()

  return (
    <div className="sticky top-20 space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-bold text-foreground">{t('storefront.orderPanel.title')}</h2>
        <span className="text-xs text-muted-foreground">{t('storefront.orderPanel.itemCount', { count: items.length })}</span>
      </div>

      {items.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{t('storefront.cart.empty')}</p>
      ) : (
        <>
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {items.map((item) => (
              <OrderPanelRow key={item.id} item={item} onCommit={onCommit} />
            ))}
          </div>

          <div className="flex justify-end">
            <ClearCartButton sessionToken={getStorefrontCartToken(slug)} onCleared={onClear} onError={onError} />
          </div>

          <OrderTotalsSummary totals={totals} />

          <Button asChild size="lg" className="w-full">
            <Link to={`/tienda/${slug}/carrito`}>{t('storefront.orderPanel.continue')}</Link>
          </Button>
        </>
      )}
    </div>
  )
}

function OrderPanelRow({ item, onCommit }: { item: StorefrontCartItem; onCommit: (itemId: string, quantity: number) => Promise<void> }) {
  const { value, saving, nudge, flushNow } = useDebouncedQuantity(item.quantity, (quantity) => onCommit(item.id, quantity))

  return (
    <div className="flex items-center gap-2.5">
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md bg-muted">
        <StorefrontImage src={item.image_url} alt={item.name} className="h-full w-full" iconClassName="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{item.name}</p>
        {item.variant_label && <p className="truncate text-[11px] text-muted-foreground">{item.variant_label}</p>}
        <p className="text-xs text-muted-foreground">{formatCurrency(item.unit_price)}</p>
      </div>
      <div className={`relative flex shrink-0 items-center rounded-md border text-xs ${saving ? 'border-primary/60' : 'border-border'}`}>
        <button type="button" onClick={() => nudge(-1)} className="px-1.5 py-1 text-foreground">
          −
        </button>
        <span className="w-4 text-center">{value}</span>
        <button type="button" onClick={() => nudge(1)} className="px-1.5 py-1 text-foreground">
          +
        </button>
        {saving && (
          <span className="absolute -top-1.5 -right-1.5 flex size-3 items-center justify-center rounded-full bg-background">
            <Loader2Icon className="size-2.5 animate-spin text-primary" />
          </span>
        )}
      </div>
      <button type="button" onClick={() => flushNow(0)} className="shrink-0 text-muted-foreground hover:text-destructive">
        <TrashIcon className="size-3.5" />
      </button>
    </div>
  )
}
