import { useEffect, useState, type FormEvent } from 'react'
import { recordManualPayment } from '../../../lib/api/billing'
import type { PaymentInvoice } from '../../../types/domain'
import { Button, CurrencyInput, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'
import { useLanguage } from '../../../contexts/LanguageContext'

const PAYMENT_METHODS = ['efectivo', 'transferencia', 'tarjeta', 'otro'] as const

/** Records a payment collected outside Wompi (bank transfer, cash, etc.) and
 * flips the invoice to PAID -- the only path to PAID before this was the
 * Wompi webhook. Shared by the global Facturas tab and TenantBillingSection
 * so a superadmin can do this from either place. */
export function ManualPaymentDrawer({
  open,
  onClose,
  invoice,
  onRecorded,
}: {
  open: boolean
  onClose: () => void
  invoice: PaymentInvoice | null
  onRecorded: (invoice: PaymentInvoice) => void
}) {
  const { t } = useLanguage()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('transferencia')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !invoice) return
    setAmount(String(invoice.amount_cents / 100))
    setMethod('transferencia')
    setReference('')
    setNote('')
    setTouched(false)
    setFormError(null)
  }, [open, invoice])

  const amountError = touched && (!amount || Number(amount) <= 0) ? t('backoffice.manualPaymentDrawer.errors.amount') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!invoice || !amount || Number(amount) <= 0) return

    setSubmitting(true)
    setFormError(null)
    try {
      const updated = await recordManualPayment(invoice.id, {
        amountCents: Math.round(Number(amount) * 100),
        paymentMethod: method,
        paymentReference: reference.trim() || null,
        note: note.trim() || null,
      })
      onRecorded(updated)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('backoffice.manualPaymentDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('backoffice.manualPaymentDrawer.title')}
      description={invoice ? t('backoffice.manualPaymentDrawer.description', { invoice: invoice.invoice_number ?? invoice.id.slice(0, 8) }) : ''}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="manual-payment-amount">{t('backoffice.manualPaymentDrawer.amount')}</Label>
          <CurrencyInput id="manual-payment-amount" min={1} step={1} value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />
          <FieldError message={amountError} />
        </div>

        <div>
          <Label htmlFor="manual-payment-method">{t('backoffice.manualPaymentDrawer.method')}</Label>
          <Select id="manual-payment-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`backoffice.manualPaymentDrawer.method.${m}`)}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="manual-payment-reference">{t('backoffice.manualPaymentDrawer.reference')}</Label>
          <Input
            id="manual-payment-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t('backoffice.manualPaymentDrawer.reference.placeholder')}
          />
        </div>

        <div>
          <Label htmlFor="manual-payment-note">{t('backoffice.manualPaymentDrawer.note')}</Label>
          <Textarea id="manual-payment-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? t('backoffice.manualPaymentDrawer.saving') : t('backoffice.manualPaymentDrawer.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
