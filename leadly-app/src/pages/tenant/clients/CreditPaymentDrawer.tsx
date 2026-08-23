import { useEffect, useState, type FormEvent } from 'react'
import { createCreditPayment, CREDIT_PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/credit'
import type { CreditPayment, CreditPaymentMethod } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Registers an abono against a client's overall credit balance -- not
 * tied to a specific order (see credit_payments in the migration). Creation
 * only, same criterion as orders/PaymentDrawer.tsx: a mistaken abono is
 * deleted and re-created, never edited in place. */
export function CreditPaymentDrawer({
  open,
  onClose,
  tenantId,
  clientId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  clientId: string
  onSaved: (payment: CreditPayment) => void
}) {
  const { t } = useLanguage()
  const [method, setMethod] = useState<CreditPaymentMethod>('efectivo')
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

  const amountError = touched && !(Number(amount) > 0) ? t('credit.paymentDrawer.errors.amountInvalid') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(Number(amount) > 0)) return

    setSubmitting(true)
    try {
      const payment = await createCreditPayment({
        tenant_id: tenantId,
        client_id: clientId,
        method,
        amount: Number(amount),
        paid_at: paidAt || undefined,
        notes: notes.trim() || null,
      })
      onSaved(payment)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('credit.paymentDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('credit.paymentDrawer.title')} description={t('credit.paymentDrawer.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="credit-payment-method">{t('credit.paymentDrawer.fields.method')}</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as CreditPaymentMethod)}>
            <SelectTrigger id="credit-payment-method" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CREDIT_PAYMENT_METHOD_LABEL_KEY) as CreditPaymentMethod[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {t(CREDIT_PAYMENT_METHOD_LABEL_KEY[m])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="credit-payment-amount">{t('credit.paymentDrawer.fields.amount')}</Label>
            <CurrencyInput id="credit-payment-amount" value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
            <FieldError message={amountError} />
          </div>
          <div>
            <Label htmlFor="credit-payment-date">{t('credit.paymentDrawer.fields.date')}</Label>
            <Input id="credit-payment-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="mt-1" />
          </div>
        </div>

        <div>
          <Label htmlFor="credit-payment-notes">{t('credit.paymentDrawer.fields.notes')}</Label>
          <Textarea id="credit-payment-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" disabled={submitting}>
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
