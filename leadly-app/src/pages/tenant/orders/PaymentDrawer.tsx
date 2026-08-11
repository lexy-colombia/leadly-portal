import { useEffect, useState, type FormEvent } from 'react'
import { createPayment, PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import type { OrderPaymentMethod } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, CurrencyInput, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'

/** Creation only -- a payment logged by mistake is deleted and re-created
 * from VentaDetalle.tsx, never edited in place (see the plan's reasoning:
 * keeps this consistent with the rest of the CRM's "simple by default"
 * criterion instead of adding an edit path nothing else needs yet). */
export function PaymentDrawer({
  open,
  onClose,
  tenantId,
  orderId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  orderId: string
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [method, setMethod] = useState<OrderPaymentMethod>('efectivo')
  const [amount, setAmount] = useState('')
  const [paidAt, setPaidAt] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMethod('efectivo')
    setAmount('')
    setPaidAt(new Date().toISOString().slice(0, 10))
    setNotes('')
    setTouched(false)
    setFormError(null)
  }, [open])

  const amountError = touched && !(Number(amount) > 0) ? t('orders.paymentDrawer.errors.amountInvalid') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(Number(amount) > 0)) return

    setSubmitting(true)
    try {
      await createPayment({
        tenant_id: tenantId,
        order_id: orderId,
        method,
        amount: Number(amount),
        paid_at: paidAt || undefined,
        notes: notes.trim() || null,
      })
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('orders.paymentDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('orders.paymentDrawer.title')} description={t('orders.paymentDrawer.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="payment-method">{t('orders.paymentDrawer.fields.method')}</Label>
          <Select id="payment-method" value={method} onChange={(e) => setMethod(e.target.value as OrderPaymentMethod)}>
            {(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[]).map((m) => (
              <option key={m} value={m}>
                {t(PAYMENT_METHOD_LABEL_KEY[m])}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="payment-amount">{t('orders.paymentDrawer.fields.amount')}</Label>
            <CurrencyInput id="payment-amount" value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />
            <FieldError message={amountError} />
          </div>
          <div>
            <Label htmlFor="payment-date">{t('orders.paymentDrawer.fields.date')}</Label>
            <Input id="payment-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="payment-notes">{t('orders.paymentDrawer.fields.notes')}</Label>
          <Textarea id="payment-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
