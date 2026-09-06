import { useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { clearStorefrontCart, type StorefrontCartItem } from '@/lib/api/storefront'
import type { OrderTotalsBreakdown } from '@/lib/api/orders'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'

/** Botón "Vaciar carrito" con confirmación -- pedido explícito del usuario,
 * antes solo se podía sacar ítem por ítem. Compartido entre el panel del
 * catálogo (StorefrontOrderPanel) y la página de checkout (StorefrontCart) --
 * ambos dueños de su propio `items`/`totals`/`itemsRef`, así que este
 * componente no guarda ningún estado de carrito propio, solo llama a
 * `clear_cart` y delega el resultado a `onCleared` para que cada caller
 * actualice su estado (y su `itemsRef`) igual que ya hace con cualquier otra
 * mutación de carrito. */
export function ClearCartButton({
  sessionToken,
  onCleared,
  onError,
  className = '',
}: {
  sessionToken: string | null
  onCleared: (result: { items: StorefrontCartItem[]; totals: OrderTotalsBreakdown }) => void
  onError: (message: string) => void
  className?: string
}) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleConfirm() {
    if (!sessionToken) return
    setBusy(true)
    try {
      const res = await clearStorefrontCart(sessionToken)
      onCleared(res)
      setOpen(false)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('storefront.cart.checkoutError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-destructive ${className}`}
      >
        <Trash2Icon className="size-3.5" />
        {t('storefront.cart.clearCart')}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('storefront.cart.clearCartTitle')}</DialogTitle>
            <DialogDescription>{t('storefront.cart.clearCartDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirm} disabled={busy}>
              {busy ? t('common.actions.saving') : t('storefront.cart.clearCartConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
