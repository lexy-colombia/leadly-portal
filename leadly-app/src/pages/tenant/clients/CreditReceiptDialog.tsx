import { useLanguage } from '../../../contexts/LanguageContext'
import { useAuth } from '../../../contexts/AuthContext'
import { formatDate } from '../../../lib/dates'
import { CREDIT_PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/credit'
import type { Client, CreditPayment } from '../../../types/domain'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** A printable view of one abono -- "crear un recibo" from the request,
 * kept deliberately simple (browser print, no PDF generation pipeline
 * exists anywhere else in the app) instead of a whole document-generation
 * feature nobody asked for. */
export function CreditReceiptDialog({ open, onClose, payment, client }: { open: boolean; onClose: () => void; payment: CreditPayment | null; client: Client | null }) {
  const { t } = useLanguage()
  const { tenant } = useAuth()

  if (!payment || !client) return null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm print:shadow-none">
        <DialogHeader>
          <DialogTitle>{t('credit.receipt.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 rounded-xl border border-brand-100 p-4 text-sm">
          <div className="flex items-center justify-between border-b border-dashed border-brand-200 pb-2">
            <span className="font-semibold text-brand-800">{tenant?.name}</span>
            <span className="text-xs text-brand-400">
              {t('credit.receipt.number')} {payment.receipt_number}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-brand-500">{t('credit.receipt.client')}</span>
            <span className="font-medium text-brand-800">{client.full_name}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-brand-500">{t('credit.receipt.amount')}</span>
            <span className="font-medium text-brand-800">{formatCurrency(payment.amount, payment.currency)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-brand-500">{t('credit.receipt.method')}</span>
            <span className="font-medium text-brand-800">{t(CREDIT_PAYMENT_METHOD_LABEL_KEY[payment.method])}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-brand-500">{t('credit.receipt.date')}</span>
            <span className="font-medium text-brand-800">{formatDate(payment.paid_at)}</span>
          </div>
          {payment.notes && (
            <div className="border-t border-dashed border-brand-200 pt-2">
              <span className="text-brand-500">{t('credit.receipt.notes')}</span>
              <p className="mt-0.5 text-brand-700">{payment.notes}</p>
            </div>
          )}
        </div>
        <DialogFooter className="print:hidden">
          <Button variant="ghost" onClick={onClose}>
            {t('credit.receipt.close')}
          </Button>
          <Button onClick={() => window.print()}>{t('credit.receipt.print')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
