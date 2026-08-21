import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { formatDate } from '../../lib/dates'
import {
  createCheckoutForInvoice,
  getActiveSubscriptionForTenant,
  listBillingPlans,
  listInvoicesForTenant,
} from '../../lib/api/billing'
import type { BillingPlan, BillingSubscription, PaymentInvoice, PaymentInvoiceStatus } from '../../types/domain'
import { Badge, Button, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, CardSection, EmptyState, Pagination } from '@/components/molecules'
const PAGE_SIZE = 8

const STATUS_KEY: Record<PaymentInvoiceStatus, TranslationKey> = {
  PENDING: 'billing.invoiceStatus.pending',
  PAID: 'billing.invoiceStatus.paid',
  OVERDUE: 'billing.invoiceStatus.overdue',
  CANCELLED: 'billing.invoiceStatus.cancelled',
  REFUNDED: 'billing.invoiceStatus.refunded',
}

const STATUS_TONE: Record<PaymentInvoiceStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  PENDING: 'warning',
  PAID: 'success',
  OVERDUE: 'danger',
  CANCELLED: 'neutral',
  REFUNDED: 'neutral',
}

const SUBSCRIPTION_STATUS_KEY: Record<BillingSubscription['status'], TranslationKey> = {
  ACTIVE: 'billing.subscriptionStatus.active',
  CANCELLED: 'billing.subscriptionStatus.cancelled',
  PAST_DUE: 'billing.subscriptionStatus.pastDue',
  EXPIRED: 'billing.subscriptionStatus.expired',
  PENDING_PAYMENT: 'billing.subscriptionStatus.pendingPayment',
}

function formatMoney(amountCents: number, currency: string): string {
  // Currency stays Colombian-formatted regardless of language -- only surrounding labels translate.
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

function PayButton({ invoice }: { invoice: PaymentInvoice }) {
  const { t } = useLanguage()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePay() {
    setLoading(true)
    setError(null)
    try {
      const checkoutUrl = await createCheckoutForInvoice(invoice.id, window.location.href)
      window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('billing.errors.payLinkFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="text-right">
      <Button variant="secondary" onClick={handlePay} disabled={loading} className="!px-3 !py-1.5 text-xs">
        {loading ? t('billing.invoices.generating') : t('billing.invoices.payNow')}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export function Billing() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const tenantId = profile?.tenant_id ?? null

  const [subscription, setSubscription] = useState<BillingSubscription | null | undefined>(undefined)
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [invoices, setInvoices] = useState<PaymentInvoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  useEffect(() => {
    if (!tenantId) return
    getActiveSubscriptionForTenant(tenantId)
      .then(setSubscription)
      .catch((err) => setError(err.message ?? t('billing.errors.loadPlan')))
    listInvoicesForTenant(tenantId)
      .then(setInvoices)
      .catch((err) => setError(err.message ?? t('billing.errors.loadInvoices')))
    listBillingPlans().then(setPlans).catch(() => setPlans([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  const plan = plans?.find((p) => p.id === subscription?.plan_id)
  const totalPages = invoices ? Math.max(1, Math.ceil(invoices.length / PAGE_SIZE)) : 1
  const pageItems = invoices ? invoices.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  if (!tenantId) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-4">
      <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">{t('billing.title')}</h1>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <Card padded={false}>
        <CardSection title={t('billing.plan.title')}>
          {subscription === undefined && <PageSpinner />}
          {subscription === null && <EmptyState>{t('billing.plan.empty')}</EmptyState>}
          {subscription && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <span className="font-medium text-brand-800">{plan?.name ?? t('billing.plan.fallbackName')}</span>
                <span className="ml-2 text-brand-400">
                  {plan
                    ? t(plan.billing_interval === 'monthly' ? 'billing.plan.priceMonthly' : 'billing.plan.priceYearly', {
                        amount: formatMoney(plan.amount_cents, plan.currency),
                      })
                    : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-brand-400">{t('billing.plan.nextDue', { date: formatDate(subscription.current_period_end) })}</span>
                <Badge tone={subscription.status === 'ACTIVE' ? 'success' : subscription.status === 'PENDING_PAYMENT' ? 'warning' : 'danger'}>
                  {t(SUBSCRIPTION_STATUS_KEY[subscription.status])}
                </Badge>
              </div>
            </div>
          )}
        </CardSection>

        <CardSection title={t('billing.invoices.title')}>
          {!invoices && <PageSpinner />}
          {invoices && invoices.length === 0 && <EmptyState>{t('billing.invoices.empty')}</EmptyState>}
          {pageItems && pageItems.length > 0 && (
            <>
              <Table bare>
                <THead>
                  <tr>
                    <TH>{t('billing.invoices.table.invoice')}</TH>
                    <TH>{t('billing.invoices.table.amount')}</TH>
                    <TH>{t('billing.invoices.table.status')}</TH>
                    <TH>{t('billing.invoices.table.dueDate')}</TH>
                    <TH className="text-right">{t('billing.invoices.table.actions')}</TH>
                  </tr>
                </THead>
                <TBody>
                  {pageItems.map((invoice) => (
                    <TRow key={invoice.id}>
                      <TD className="font-medium text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</TD>
                      <TD>{formatMoney(invoice.amount_cents, invoice.currency)}</TD>
                      <TD>
                        <Badge tone={STATUS_TONE[invoice.status]}>{t(STATUS_KEY[invoice.status])}</Badge>
                      </TD>
                      <TD className="text-brand-400">{formatDate(invoice.due_date)}</TD>
                      <TD>{invoice.status === 'PENDING' || invoice.status === 'OVERDUE' ? <PayButton invoice={invoice} /> : null}</TD>
                    </TRow>
                  ))}
                </TBody>
              </Table>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </>
          )}
        </CardSection>
      </Card>
    </div>
  )
}
