import { useState } from 'react'
import { useLanguage } from '@/contexts/LanguageContext'
import { createCheckoutForInvoice } from '@/lib/api/billing'
import { Button } from '@/components/ui/button'

/** "Pagar ahora" de un comprobante de cobro: pide el checkout al backend (que decide si se puede
 * cobrar) y lo abre en otra pestana. Muestra tal cual el error que devuelva el backend. */
export function InvoicePayButton({ invoiceId }: { invoiceId: string }) {
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePay() {
    setLoading(true)
    setError(null)
    try {
      const checkoutUrl = await createCheckoutForInvoice(invoiceId, window.location.href)
      window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('billing.errors.payLinkFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="text-right">
      <Button onClick={handlePay} disabled={loading} size="sm">
        {loading ? t('billing.invoices.generating') : t('billing.invoices.payNow')}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
