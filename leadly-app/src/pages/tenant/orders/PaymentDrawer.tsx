import { useEffect, useState, type FormEvent } from 'react'
import { createPayment, createWompiPaymentLink, PAYMENT_METHOD_LABEL_KEY } from '../../../lib/api/orderPayments'
import { getPaymentCredentialStatus } from '../../../lib/api/billing'
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
import { Copy } from 'lucide-react'

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

  // Wompi: only offered once the tenant's own account is fully connected
  // (same "Conectado" criterion as WompiIntegrationDrawer -- a credential
  // row with empty secrets doesn't count). Independent from the manual
  // form below: generating a link doesn't record a payment by itself, only
  // payment-webhook-wompi does that once the customer actually pays.
  const [wompiConnected, setWompiConnected] = useState(false)
  const [wompiLink, setWompiLink] = useState<{ checkoutUrl: string; amount: number } | null>(null)
  const [wompiGenerating, setWompiGenerating] = useState(false)
  const [wompiError, setWompiError] = useState<string | null>(null)
  const [wompiCopied, setWompiCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setMethod('efectivo')
    setAmount(pendingAmount > 0 ? String(pendingAmount) : '')
    setPaidAt(new Date().toISOString().slice(0, 10))
    setNotes('')
    setTouched(false)
    setFormError(null)
    setWompiLink(null)
    setWompiError(null)
    setWompiCopied(false)
    getPaymentCredentialStatus(tenantId)
      .then((status) => setWompiConnected(status.configuredSecrets.includes('private_key') && status.configuredSecrets.includes('events_key')))
      .catch(() => setWompiConnected(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function handleGenerateWompiLink() {
    setWompiGenerating(true)
    setWompiError(null)
    try {
      const result = await createWompiPaymentLink(orderId)
      setWompiLink({ checkoutUrl: result.checkoutUrl, amount: result.amount })
    } catch (err) {
      setWompiError(err instanceof Error ? err.message : t('orders.paymentDrawer.wompi.errors.generate'))
    } finally {
      setWompiGenerating(false)
    }
  }

  async function handleCopyWompiLink() {
    if (!wompiLink) return
    await navigator.clipboard.writeText(wompiLink.checkoutUrl)
    setWompiCopied(true)
    setTimeout(() => setWompiCopied(false), 2000)
  }

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
      {wompiConnected && pendingAmount > 0 && (
        <div className="mb-4 space-y-2 rounded-lg border border-brand-100 bg-brand-50/40 p-3">
          <p className="text-xs font-medium text-brand-700">{t('orders.paymentDrawer.wompi.title')}</p>
          {!wompiLink ? (
            <>
              <p className="text-[11px] text-brand-400">{t('orders.paymentDrawer.wompi.hint', { amount: formatCurrency(pendingAmount) })}</p>
              <Button type="button" variant="secondary" size="sm" onClick={handleGenerateWompiLink} disabled={wompiGenerating}>
                {wompiGenerating ? t('orders.paymentDrawer.wompi.generating') : t('orders.paymentDrawer.wompi.generate')}
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Input readOnly value={wompiLink.checkoutUrl} className="flex-1 text-xs" onFocus={(e) => e.target.select()} />
              <Button type="button" variant="secondary" size="icon-sm" onClick={handleCopyWompiLink} aria-label={t('orders.paymentDrawer.wompi.copyAria')}>
                <Copy className="size-3.5" />
              </Button>
            </div>
          )}
          {wompiCopied && <p className="text-[11px] text-emerald-600">{t('orders.paymentDrawer.wompi.copied')}</p>}
          {wompiError && <p className="text-[11px] text-red-600">{wompiError}</p>}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="payment-method">{t('orders.paymentDrawer.fields.method')}</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as OrderPaymentMethod)}>
            <SelectTrigger id="payment-method" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PAYMENT_METHOD_LABEL_KEY) as OrderPaymentMethod[])
                // 'wompi' never shows here -- it's only ever recorded
                // automatically by payment-webhook-wompi once a customer
                // actually pays a generated link (see the section above),
                // never picked and typed in manually.
                .filter((m) => m !== 'wompi' && (m !== 'credito' || creditEnabled) && (m !== 'saldo_favor' || storeCreditBalance > 0))
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
