import { useEffect, useState } from 'react'
import {
  assignTenantToPlan,
  cancelSubscription,
  getActiveSubscriptionForTenant,
  getTenantEntitlements,
  listBillingPlans,
  reactivateSubscription,
  type TenantEntitlements,
} from '../../../lib/api/billing'
import type { BillingPlan, BillingSubscription } from '../../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { ConfirmDialog } from '@/components/organisms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDate } from '../../../lib/dates'
import { ApplyPlanDialog } from './ApplyPlanDialog'
import { NegotiationDrawer } from './NegotiationDrawer'

const LIMIT_ROWS: { key: keyof NonNullable<TenantEntitlements['limits']>; labelKey: TranslationKey }[] = [
  { key: 'max_users', labelKey: 'backoffice.planDrawer.limits.maxUsers' },
  { key: 'max_warehouses', labelKey: 'backoffice.planDrawer.limits.maxWarehouses' },
  { key: 'max_pos_points', labelKey: 'backoffice.planDrawer.limits.maxPosPoints' },
  { key: 'max_whatsapp_lines', labelKey: 'backoffice.planDrawer.limits.maxWhatsappLines' },
  { key: 'max_ai_agents', labelKey: 'backoffice.planDrawer.limits.maxAiAgents' },
  { key: 'max_ai_messages_month', labelKey: 'backoffice.planDrawer.limits.maxAiMessagesMonth' },
]

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
  const [entitlements, setEntitlements] = useState<TenantEntitlements | null>(null)
  const [entitlementsError, setEntitlementsError] = useState(false)
  const [negotiationOpen, setNegotiationOpen] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)

  function reloadEntitlements() {
    setEntitlementsError(false)
    getTenantEntitlements(tenantId)
      .then(setEntitlements)
      .catch(() => setEntitlementsError(true))
  }

  function reload() {
    getActiveSubscriptionForTenant(tenantId)
      .then(setSubscription)
      .catch((err) => setError(err.message ?? t('backoffice.tenantBilling.errors.loadSubscription')))
  }

  useEffect(reload, [tenantId])
  // Effective limits/modules depend on which subscription/plan is current, so
  // they're re-read whenever either changes.
  useEffect(() => {
    if (subscription) reloadEntitlements()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, subscription?.id, subscription?.plan_id, subscription?.custom_base_amount_cents])
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
          <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('backoffice.tenantBilling.selectPlan')} />
            </SelectTrigger>
            <SelectContent>
              {plans
                ?.filter((p) => p.is_active)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {formatMoney(p.amount_cents, p.currency)}/
                    {p.billing_interval === 'monthly' ? t('backoffice.tenantBilling.perMonth') : t('backoffice.tenantBilling.perYear')}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1.5">
            <Button size="xs" onClick={handleAssignPlan} disabled={!selectedPlanId || assigning}>
              {assigning ? t('backoffice.tenantBilling.assigning') : t('backoffice.tenantBilling.assignPlan')}
            </Button>
            {changingPlan && (
              <Button variant="ghost" size="xs" onClick={() => setChangingPlan(false)}>
                {t('common.actions.cancel')}
              </Button>
            )}
          </div>
        </div>
      )}

      {subscription && !showAssignForm && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-brand-800">{plan?.name ?? t('backoffice.tenantBilling.plan')}</span>
            <Badge
              variant="outline"
              className={
                subscription.status === 'ACTIVE'
                  ? 'border-transparent bg-emerald-100 text-emerald-700'
                  : subscription.status === 'PENDING_PAYMENT'
                    ? 'border-transparent bg-amber-100 text-amber-700'
                    : 'border-transparent bg-red-100 text-red-700'
              }
            >
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
          {plan?.is_custom && (
            <p className="text-xs text-brand-500">
              {subscription.custom_base_amount_cents != null
                ? t('backoffice.tenantPlan.customBase', { amount: formatMoney(subscription.custom_base_amount_cents, plan.currency) })
                : t('backoffice.tenantPlan.customPending')}
            </p>
          )}
          {entitlementsError && <p className="text-xs text-red-600">{t('backoffice.tenantPlan.entitlementsError')}</p>}
          {entitlements?.limits && (
            <div className="mt-2 rounded-lg border border-brand-100 px-2.5 py-2">
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{t('backoffice.tenantPlan.limits')}</p>
              <dl className="space-y-0.5">
                {LIMIT_ROWS.map((row) => {
                  const value = entitlements.limits?.[row.key]
                  return (
                    <div key={row.key} className="flex items-center justify-between gap-2 text-xs">
                      <dt className="text-brand-500">{t(row.labelKey)}</dt>
                      <dd className="font-medium text-brand-800">{value == null ? t('backoffice.facturacion.table.maxUsers.unlimited') : value}</dd>
                    </div>
                  )
                })}
              </dl>
              <p className="mt-1.5 text-xs text-brand-500">{t('backoffice.tenantPlan.modulesCount', { count: String(entitlements.modules.length) })}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {plan?.is_custom && (
              <Button size="xs" onClick={() => setNegotiationOpen(true)}>
                {t('backoffice.tenantPlan.negotiate')}
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => setApplyOpen(true)}>
              {t('backoffice.tenantPlan.applyToModules')}
            </Button>
          </div>
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

      {subscription && plan?.is_custom && (
        <NegotiationDrawer
          open={negotiationOpen}
          onClose={() => setNegotiationOpen(false)}
          subscription={subscription}
          plan={plan}
          onSaved={(saved) => {
            setSubscription(saved)
            reloadEntitlements()
          }}
        />
      )}
      <ApplyPlanDialog open={applyOpen} onClose={() => setApplyOpen(false)} tenantId={tenantId} onApplied={reloadEntitlements} />

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
