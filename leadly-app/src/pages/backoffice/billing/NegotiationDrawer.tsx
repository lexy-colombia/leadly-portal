import { useEffect, useMemo, useState } from 'react'
import { createInvoiceForSubscription, listSubscriptionModules, saveSubscriptionNegotiation } from '../../../lib/api/billing'
import type { BillingPlan, BillingSubscription } from '../../../types/domain'
import { CurrencyInput } from '@/components/molecules'
import { ConfirmDialog, Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { PLAN_MODULE_GROUPS, moduleLabelKey } from '../../../lib/planModules'

interface ModuleRow {
  checked: boolean
  price: string
  note: string
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100)
}

/** Per-tenant negotiation of a custom (Enterprise) plan: base monthly price,
 * which modules are contracted and at what monthly price, and the setup-fee
 * override. The total shown is only a live preview of what the server will
 * invoice (base + sum of contracted module prices) -- the invoice amount is
 * always computed server-side by create_invoice_for_subscription. */
export function NegotiationDrawer({
  open,
  onClose,
  subscription,
  plan,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  subscription: BillingSubscription
  plan: BillingPlan
  onSaved: (subscription: BillingSubscription) => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [baseAmount, setBaseAmount] = useState('')
  const [setupFee, setSetupFee] = useState('')
  const [rows, setRows] = useState<Record<string, ModuleRow>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The negotiation as last saved: the first invoice is computed from what's
  // stored, so it's what the confirmation shows and what "dirty" compares to.
  const [savedSub, setSavedSub] = useState<BillingSubscription>(subscription)
  const [dirty, setDirty] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [invoicing, setInvoicing] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSavedSub(subscription)
    setDirty(false)
    setConfirmOpen(false)
    setBaseAmount(subscription.custom_base_amount_cents != null ? String(subscription.custom_base_amount_cents / 100) : '')
    setSetupFee(subscription.setup_fee_override_cents != null ? String(subscription.setup_fee_override_cents / 100) : '')
    setLoading(true)
    listSubscriptionModules(subscription.id)
      .then((list) => {
        const next: Record<string, ModuleRow> = {}
        for (const m of list) next[m.module_key] = { checked: true, price: m.price_cents ? String(m.price_cents / 100) : '', note: m.note ?? '' }
        setRows(next)
      })
      .catch((err) => {
        setRows({})
        setError(err instanceof Error ? err.message : t('backoffice.negotiation.errors.load'))
      })
      .finally(() => setLoading(false))
  }, [open, subscription, t])

  function patchRow(moduleKey: string, patch: Partial<ModuleRow>) {
    setDirty(true)
    setRows((prev) => ({ ...prev, [moduleKey]: { ...(prev[moduleKey] ?? { checked: false, price: '', note: '' }), ...patch } }))
  }

  const totalCents = useMemo(() => {
    const base = baseAmount.trim() === '' ? 0 : Math.round(Number(baseAmount) * 100)
    const modules = Object.values(rows).reduce((sum, r) => (r.checked && r.price.trim() !== '' ? sum + Math.round(Number(r.price) * 100) : sum), 0)
    return base + modules
  }, [baseAmount, rows])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const saved = await saveSubscriptionNegotiation(subscription.id, {
        customBaseAmountCents: baseAmount.trim() === '' ? null : Math.round(Number(baseAmount) * 100),
        setupFeeOverrideCents: setupFee.trim() === '' ? null : Math.round(Number(setupFee) * 100),
        modules: Object.entries(rows)
          .filter(([, r]) => r.checked)
          .map(([module_key, r]) => ({
            module_key,
            price_cents: r.price.trim() === '' ? 0 : Math.round(Number(r.price) * 100),
            note: r.note.trim() || null,
          })),
      })
      toast.success(t('backoffice.negotiation.saved'))
      onSaved(saved)
      // Stay open: the superadmin may now issue the first invoice explicitly.
      setSavedSub(saved)
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.negotiation.errors.save'))
    } finally {
      setSaving(false)
    }
  }

  async function handleIssueInvoice() {
    setInvoicing(true)
    setError(null)
    try {
      const created = await createInvoiceForSubscription(subscription.id)
      setConfirmOpen(false)
      if (created) {
        toast.success(
          created.invoiceNumber
            ? t('backoffice.negotiation.invoice.created', { number: created.invoiceNumber })
            : t('backoffice.negotiation.invoice.createdNoNumber'),
        )
      } else {
        toast.info(t('backoffice.negotiation.invoice.nothing'))
      }
    } catch (err) {
      setConfirmOpen(false)
      setError(err instanceof Error ? err.message : t('backoffice.negotiation.errors.invoice'))
    } finally {
      setInvoicing(false)
    }
  }

  const pendingPayment = savedSub.status === 'PENDING_PAYMENT'
  const setupFeeShownCents = savedSub.setup_fee_override_cents ?? plan.setup_fee_cents
  // Total as stored (what the invoice will use), same display-only sum as above.
  const savedTotalCents = !dirty ? totalCents : null

  return (
    <Drawer open={open} onClose={onClose} title={t('backoffice.negotiation.title')} description={t('backoffice.negotiation.description', { plan: plan.name })} size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="neg-base">{t('backoffice.negotiation.baseAmount')}</Label>
            <CurrencyInput id="neg-base" min={0} step={1} value={baseAmount} onChange={(e) => {
                setDirty(true)
                setBaseAmount(e.target.value)
              }} />
            <p className="mt-1 text-[11px] text-brand-400">{t('backoffice.negotiation.baseAmount.hint')}</p>
          </div>
          <div>
            <Label htmlFor="neg-setup">{t('backoffice.negotiation.setupFee')}</Label>
            <CurrencyInput id="neg-setup" min={0} step={1} value={setupFee} onChange={(e) => {
                setDirty(true)
                setSetupFee(e.target.value)
              }} />
            <p className="mt-1 text-[11px] text-brand-400">{t('backoffice.negotiation.setupFee.hint')}</p>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('backoffice.negotiation.modules.title')}</p>
          {loading ? (
            <p className="mt-2 text-xs text-brand-400">{t('common.actions.loading')}</p>
          ) : (
            <div className="mt-2 space-y-3">
              {PLAN_MODULE_GROUPS.map((group) => (
                <div key={group.key} className="rounded-xl border border-brand-100 p-3">
                  <p className="text-xs font-semibold text-brand-700">{t(group.labelKey)}</p>
                  <div className="mt-2 space-y-2">
                    {group.modules.map((moduleKey) => {
                      const row = rows[moduleKey]
                      const labelKey = moduleLabelKey(moduleKey)
                      const label = labelKey ? t(labelKey) : moduleKey
                      return (
                        <div key={moduleKey} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-2">
                          <label className="flex min-w-0 items-center gap-2 text-xs text-brand-700">
                            <Checkbox checked={row?.checked ?? false} onCheckedChange={(c) => patchRow(moduleKey, { checked: c === true })} />
                            <span className="truncate">{label}</span>
                          </label>
                          <CurrencyInput
                            aria-label={t('backoffice.negotiation.modulePrice', { module: label })}
                            min={0}
                            step={1}
                            disabled={!row?.checked}
                            value={row?.price ?? ''}
                            onChange={(e) => patchRow(moduleKey, { price: e.target.value })}
                          />
                          <Input
                            aria-label={t('backoffice.negotiation.moduleNote', { module: label })}
                            disabled={!row?.checked}
                            value={row?.note ?? ''}
                            onChange={(e) => patchRow(moduleKey, { note: e.target.value })}
                            placeholder={t('backoffice.negotiation.notePlaceholder')}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2.5">
          <span className="text-xs font-medium text-brand-700">{t('backoffice.negotiation.total')}</span>
          <span className="text-sm font-semibold text-brand-800">{formatMoney(totalCents, plan.currency)}</span>
        </div>
        <p className="text-[11px] text-brand-400">{t('backoffice.negotiation.total.hint')}</p>

        {pendingPayment && totalCents <= 0 && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('backoffice.negotiation.invoice.zeroNotice')}</p>}
        {pendingPayment && totalCents > 0 && (
          <div className="space-y-1.5 rounded-lg border border-brand-100 px-3 py-2.5">
            <Button type="button" onClick={() => setConfirmOpen(true)} disabled={dirty || saving || loading || invoicing}>
              {t('backoffice.negotiation.invoice.issue')}
            </Button>
            <p className="text-[11px] text-brand-400">{dirty ? t('backoffice.negotiation.invoice.saveFirst') : t('backoffice.negotiation.invoice.hint')}</p>
          </div>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="button" onClick={handleSave} disabled={saving || loading}>
            {saving ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleIssueInvoice}
        title={t('backoffice.negotiation.invoice.confirmTitle')}
        description={t('backoffice.negotiation.invoice.confirmDescription', {
          monthly: formatMoney(savedTotalCents ?? totalCents, plan.currency),
          setup: formatMoney(setupFeeShownCents, plan.currency),
        })}
        confirmLabel={t('backoffice.negotiation.invoice.issue')}
        confirmVariant="primary"
        loading={invoicing}
      />
    </Drawer>
  )
}
