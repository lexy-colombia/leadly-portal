import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { createCheckoutForInvoice } from '@/lib/api/billing'
import { Button } from '@/components/ui/button'

/** "Pagar ahora" de un comprobante de cobro: pide el checkout al backend (que decide si se puede
 * cobrar) y lo abre en otra pestana. Muestra tal cual el error que devuelva el backend.
 * `variant="hero"` es la version grande de ancho completo del muro de pago. */
export function InvoicePayButton({ invoiceId, variant = 'row' }: { invoiceId: string; variant?: 'row' | 'hero' }) {
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

  const label = loading ? t('billing.invoices.generating') : t('billing.invoices.payNow')

  if (variant === 'hero') {
    return (
      <div>
        <Button onClick={handlePay} disabled={loading} className="h-11 w-full text-sm font-semibold">
          {label}
          {!loading && <ArrowRight className="size-4" />}
        </Button>
        {error && <p className="mt-2 text-center text-xs text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div className="text-right">
      <Button onClick={handlePay} disabled={loading} size="sm">
        {label}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
