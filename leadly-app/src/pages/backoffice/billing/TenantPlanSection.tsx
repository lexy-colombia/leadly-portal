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
import { Card } from '@/components/molecules'
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

/** Subscription management and effective limits in the client detail's
 * dedicated plan section. Invoice/payment operations remain separate. */
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
        <div className="flex flex-col gap-4">
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-bold text-foreground">{plan?.name ?? t('backoffice.tenantBilling.plan')}</h3>
                <Badge variant="outline" className={subscription.status === 'ACTIVE' ? 'border-transparent bg-emerald-100 text-emerald-700' : subscription.status === 'PENDING_PAYMENT' ? 'border-transparent bg-amber-100 text-amber-700' : 'border-transparent bg-red-100 text-red-700'}>
                  {t(SUBSCRIPTION_STATUS_LABEL_KEY[subscription.status])}
                </Badge>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t(plan?.is_custom ? 'backoffice.tenantPlan.negotiatedPrice' : 'backoffice.tenantPlan.planPrice')}</p>
                {plan && (!plan.is_custom || subscription.custom_base_amount_cents != null) ? (
                  <p className="text-2xl font-bold tracking-tight text-foreground">
                    {formatMoney(plan.is_custom ? subscription.custom_base_amount_cents! : plan.amount_cents, plan.currency)}
                    <span className="ml-1 text-xs font-normal tracking-normal text-muted-foreground">/ {plan.is_custom || plan.billing_interval === 'monthly' ? t('backoffice.tenantBilling.perMonth') : t('backoffice.tenantBilling.perYear')}</span>
                  </p>
                ) : <p className="text-xs text-muted-foreground">{t('backoffice.tenantPlan.customPending')}</p>}
              </div>
              <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
                <div><dt className="text-muted-foreground">{t('backoffice.tenantPlan.periodStart')}</dt><dd className="mt-1 font-medium">{formatDate(subscription.current_period_start)}</dd></div>
                <div><dt className="text-muted-foreground">{t('backoffice.tenantPlan.periodEnd')}</dt><dd className="mt-1 font-medium">{formatDate(subscription.current_period_end)}</dd></div>
              </dl>
              {subscription.cancel_at_period_end && <p className="text-xs text-amber-700">{t('backoffice.tenantPlan.cancelsOn', { date: formatDate(subscription.current_period_end) })}</p>}
              <div className="mt-auto flex flex-wrap gap-2">
                {plan?.is_custom && <Button size="sm" onClick={() => setNegotiationOpen(true)}>{t('backoffice.tenantPlan.editNegotiation')}</Button>}
                <Button variant="outline" size="sm" onClick={() => setChangingPlan(true)}>{t('backoffice.tenantPlan.change')}</Button>
              </div>
            </Card>
            <Card className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold text-foreground">{t('backoffice.tenantPlan.limits')}</h3>
              {entitlementsError && <p role="alert" className="text-xs text-red-600">{t('backoffice.tenantPlan.entitlementsError')}</p>}
              {!entitlements && !entitlementsError && <PageSpinner />}
              {entitlements?.limits && <dl className="divide-y divide-border">
                {LIMIT_ROWS.map((row) => {
                  const value = entitlements.limits?.[row.key]
                  return <div key={row.key} className="flex items-center justify-between gap-3 py-2 text-xs"><dt className="text-muted-foreground">{t(row.labelKey)}</dt><dd className="font-medium text-foreground">{value == null ? t('backoffice.facturacion.table.maxUsers.unlimited') : value}</dd></div>
                })}
              </dl>}
            </Card>
          </div>
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-xs font-semibold">{t('backoffice.tenantPlan.moduleAccess')}</h3><p className="mt-1 text-xs text-muted-foreground">{entitlements ? t('backoffice.tenantPlan.modulesCount', { count: String(entitlements.modules.length) }) : '—'}</p></div>
            <Button size="sm" variant="outline" onClick={() => setApplyOpen(true)}>{t('backoffice.tenantPlan.applyToModules')}</Button>
          </Card>
          <div className="flex justify-end border-t border-border pt-3">
            {subscription.cancel_at_period_end ? (
              <Button variant="outline" size="sm" onClick={handleReactivate} disabled={reactivating}>{reactivating ? t('backoffice.tenantPlan.reactivating') : t('backoffice.tenantPlan.reactivate')}</Button>
            ) : subscription.status !== 'CANCELLED' && subscription.status !== 'EXPIRED' && (
              <button type="button" onClick={() => setCancelConfirmOpen(true)} className="rounded-sm text-xs text-destructive outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{t('backoffice.tenantBilling.cancelSubscription')}</button>
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
