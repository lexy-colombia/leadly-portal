import { useEffect, useState } from 'react'
import { assignTenantToPlan, cancelSubscription, getActiveSubscriptionForTenant, listBillingPlans, reactivateSubscription } from '../../../lib/api/billing'
import type { BillingPlan, BillingSubscription } from '../../../types/domain'
import { Badge, Button, PageSpinner, Select } from '@/components/atoms'
import { ConfirmDialog } from '@/components/organisms'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDate } from '../../../lib/dates'

const SUBSCRIPTION_STATUS_LABEL_KEY: Record<BillingSubscription['status'], TranslationKey> = {
  ACTIVE: 'backoffice.tenantBilling.subscriptionStatus.active',
  CANCELLED: 'backoffice.tenantBilling.subscriptionStatus.cancelled',
  PAST_DUE: 'backoffice.tenantBilling.subscriptionStatus.pastDue',
  EXPIRED: 'backoffice.tenantBilling.subscriptionStatus.expired',
  PENDING_PAYMENT: 'backoffice.tenantBilling.subscriptionStatus.pendingPayment',
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

/** The tenant's plan, shown in the client detail sidebar (identity/info
 * card) rather than buried inside the "Facturación" tab -- the plan isn't a
 * billing operation, it's a fact about the tenant (and drives limits like
 * max_users/max_whatsapp_lines that other tabs read), so it belongs next to
 * legal_name/document/etc, not next to the invoice list. Facturación stays
 * scoped to invoices/payments; this owns assign/change/cancel. */
export function TenantPlanSection({ tenantId, onPlanChange }: { tenantId: string; onPlanChange?: (plan: BillingPlan | null) => void }) {
  const { t } = useLanguage()
  const [subscription, setSubscription] = useState<BillingSubscription | null | undefined>(undefined)
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [changingPlan, setChangingPlan] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [reactivating, setReactivating] = useState(false)

  function reload() {
    getActiveSubscriptionForTenant(tenantId)
      .then(setSubscription)
      .catch((err) => setError(err.message ?? t('backoffice.tenantBilling.errors.loadSubscription')))
  }

  useEffect(reload, [tenantId])
  useEffect(() => {
    listBillingPlans().then(setPlans).catch(() => setPlans([]))
  }, [])

  const plan = plans?.find((p) => p.id === subscription?.plan_id) ?? null

  useEffect(() => {
    if (subscription !== undefined) onPlanChange?.(plan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription, plans])

  async function handleAssignPlan() {
    if (!selectedPlanId) return
    setAssigning(true)
    setError(null)
    try {
      const sub = await assignTenantToPlan(tenantId, selectedPlanId)
      setSubscription(sub)
      setSelectedPlanId('')
      setChangingPlan(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.tenantBilling.errors.assignPlan'))
    } finally {
      setAssigning(false)
    }
  }

  async function handleCancelSubscription() {
    if (!subscription) return
    setCancelling(true)
    setError(null)
    try {
      const updated = await cancelSubscription(subscription.id)
      setSubscription(updated)
      setCancelConfirmOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.tenantBilling.errors.cancelSubscription'))
    } finally {
      setCancelling(false)
    }
  }

  async function handleReactivate() {
    if (!subscription) return
    setReactivating(true)
    setError(null)
    try {
      const updated = await reactivateSubscription(subscription.id)
      setSubscription(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.tenantBilling.errors.reactivateSubscription'))
    } finally {
      setReactivating(false)
    }
  }

  const showAssignForm = subscription === null || changingPlan

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-brand-400">{t('backoffice.tenantPlan.label')}</p>

      {subscription === undefined && <PageSpinner />}

      {subscription !== undefined && showAssignForm && (
        <div className="space-y-2">
          <Select value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)} className="!py-1.5 text-sm">
            <option value="">{t('backoffice.tenantBilling.selectPlan')}</option>
            {plans
              ?.filter((p) => p.is_active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatMoney(p.amount_cents, p.currency)}/
                  {p.billing_interval === 'monthly' ? t('backoffice.tenantBilling.perMonth') : t('backoffice.tenantBilling.perYear')}
                </option>
              ))}
          </Select>
          <div className="flex gap-1.5">
            <Button variant="secondary" onClick={handleAssignPlan} disabled={!selectedPlanId || assigning} className="!px-2.5 !py-1.5 text-xs">
              {assigning ? t('backoffice.tenantBilling.assigning') : t('backoffice.tenantBilling.assignPlan')}
            </Button>
            {changingPlan && (
              <Button variant="ghost" onClick={() => setChangingPlan(false)} className="!px-2.5 !py-1.5 text-xs">
                {t('common.actions.cancel')}
              </Button>
            )}
          </div>
        </div>
      )}

      {subscription && !showAssignForm && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-brand-800">{plan?.name ?? t('backoffice.tenantBilling.plan')}</span>
            <Badge tone={subscription.status === 'ACTIVE' ? 'success' : subscription.status === 'PENDING_PAYMENT' ? 'warning' : 'danger'}>
              {t(SUBSCRIPTION_STATUS_LABEL_KEY[subscription.status])}
            </Badge>
          </div>
          {plan && (
            <p className="text-xs text-brand-500">
              {formatMoney(plan.amount_cents, plan.currency)}/{plan.billing_interval === 'monthly' ? t('backoffice.tenantBilling.perMonth') : t('backoffice.tenantBilling.perYear')}
            </p>
          )}
          {subscription.cancel_at_period_end ? (
            <p className="text-xs font-medium text-amber-600">
              {t('backoffice.tenantPlan.cancelsOn', { date: formatDate(subscription.current_period_end) })}
            </p>
          ) : (
            <p className="text-xs text-brand-400">{t('backoffice.tenantBilling.expires', { date: formatDate(subscription.current_period_end) })}</p>
          )}
          <div className="flex gap-1.5 pt-0.5">
            <button type="button" onClick={() => setChangingPlan(true)} className="text-xs font-medium text-accent-600 hover:text-accent-700">
              {t('backoffice.tenantPlan.change')}
            </button>
            {subscription.cancel_at_period_end ? (
              <button type="button" onClick={handleReactivate} disabled={reactivating} className="text-xs font-medium text-accent-600 hover:text-accent-700">
                {reactivating ? t('backoffice.tenantPlan.reactivating') : t('backoffice.tenantPlan.reactivate')}
              </button>
            ) : (
              subscription.status !== 'CANCELLED' &&
              subscription.status !== 'EXPIRED' && (
                <button type="button" onClick={() => setCancelConfirmOpen(true)} className="text-xs font-medium text-red-600 hover:text-red-700">
                  {t('backoffice.tenantBilling.cancelSubscription')}
                </button>
              )
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</p>}

      <ConfirmDialog
        open={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={handleCancelSubscription}
        title={t('backoffice.tenantBilling.cancelConfirm.title')}
        description={t('backoffice.tenantBilling.cancelConfirm.description')}
        loading={cancelling}
      />
    </div>
  )
}
