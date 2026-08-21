import { AlertTriangleIcon } from 'lucide-react'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { StockShortfall } from '../../../lib/api/orders'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Shown instead of the plain inline error banner when confirming a sale
 * fails for lack of stock. Deliberately short and generic, not a per-item
 * list -- an order with 20 lines would turn this into a 20-row wall of
 * text (explicit user feedback). The specifics (which line, how much is
 * missing) live where the agent is already looking: OrderItemsEditor marks
 * every offending line's Cantidad input and "X disp." hint red. OrderDetail
 * keeps `shortfalls` around after this closes (this only controls
 * visibility, not the data) so those stay marked until actually fixed. */
export function StockShortfallDialog({ shortfalls, open, onClose }: { shortfalls: StockShortfall[]; open: boolean; onClose: () => void }) {
  const { t } = useLanguage()

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <AlertTriangleIcon className="size-4 shrink-0" />
            {t('orders.detail.errors.stockShortfallTitle')}
          </DialogTitle>
          <DialogDescription>
            {t(shortfalls.length === 1 ? 'orders.detail.errors.stockShortfallBody.singular' : 'orders.detail.errors.stockShortfallBody.plural', { count: shortfalls.length })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>{t('common.actions.understood')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
