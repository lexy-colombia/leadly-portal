import { useEffect, useState, type FormEvent } from 'react'
import { createPayment, PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import type { OrderPaymentMethod } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Creation only -- a payment logged by mistake is deleted and re-created
 * from OrderDetail.tsx, never edited in place (see the plan's reasoning:
 * keeps this consistent with the rest of the CRM's "simple by default"
 * criterion instead of adding an edit path nothing else needs yet). */
export function PaymentDrawer({
  open,
  onClose,
  tenantId,
  orderId,
  creditEnabled,
  storeCreditBalance,
  pendingAmount,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  orderId: string
  /** Only clients with clients.credit_enabled can be charged to their
   * credit account -- 'credito' is hidden from the method select
   * otherwise (also enforced server-side, see apply_credit_payment_charge). */
  creditEnabled: boolean
  /** sum(store_credit_grants) - sum(store_credit_redemptions) for this
   * order's client -- 'saldo_favor' only shows up as a method when this is
   * > 0, and a payment with that method can never exceed it (also
   * enforced server-side, see apply_store_credit_redemption()). */
  storeCreditBalance: number
  /** order.total - sum(existing payments) -- pre-fills the amount field
   * (explicit user request: the form should always open with the balance
   * still owed, not blank) and caps how much a single payment can be for
   * (a sale can't end up "overpaid"). */
  pendingAmount: number
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
    setAmount(pendingAmount > 0 ? String(pendingAmount) : '')
    setPaidAt(new Date().toISOString().slice(0, 10))
    setNotes('')
    setTouched(false)
    setFormError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const amountValue = Number(amount)
  // 'saldo_favor' has a second, tighter cap on top of pendingAmount -- can
  // never redeem more store credit than the client actually has.
  const maxAmount = method === 'saldo_favor' ? Math.min(pendingAmount, storeCreditBalance) : pendingAmount

  // Re-clamps the prefilled amount when switching into a method with a
  // lower cap (e.g. pendingAmount is bigger than the client's store
  // credit) -- otherwise the field silently opens already over the limit.
  useEffect(() => {
    if (Number(amount) > maxAmount) setAmount(maxAmount > 0 ? String(maxAmount) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method])
  const amountError = touched
    ? !(amountValue > 0)
      ? t('orders.paymentDrawer.errors.amountInvalid')
      : amountValue > maxAmount
        ? t('orders.paymentDrawer.errors.amountExceedsBalance', { amount: formatCurrency(maxAmount) })
        : undefined
    : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(amountValue > 0) || amountValue > maxAmount) return

    setSubmitting(true)
    try {
      await createPayment({
        tenant_id: tenantId,
        order_id: orderId,
        method,
        amount: amountValue,
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
          <Select value={method} onValueChange={(v) => setMethod(v as OrderPaymentMethod)}>
            <SelectTrigger id="payment-method" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[])
                .filter((m) => (m !== 'credito' || creditEnabled) && (m !== 'saldo_favor' || storeCreditBalance > 0))
                .map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(PAYMENT_METHOD_LABEL_KEY[m])}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="payment-amount">{t('orders.paymentDrawer.fields.amount')}</Label>
            <CurrencyInput id="payment-amount" value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
            {!amountError && (
              <p className="mt-1 text-[11px] text-brand-400">
                {t(method === 'saldo_favor' ? 'orders.paymentDrawer.fields.storeCreditHint' : 'orders.paymentDrawer.fields.amountHint', { amount: formatCurrency(maxAmount) })}
              </p>
            )}
            <FieldError message={amountError} />
          </div>
          <div>
            <Label htmlFor="payment-date">{t('orders.paymentDrawer.fields.date')}</Label>
            <Input id="payment-date" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="mt-1" />
          </div>
        </div>

        <div>
          <Label htmlFor="payment-notes">{t('orders.paymentDrawer.fields.notes')}</Label>
          <Textarea id="payment-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
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
