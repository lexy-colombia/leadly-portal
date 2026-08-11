import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
  createCheckoutForInvoice,
  getActiveSubscriptionForTenant,
  listBillingPlans,
  listInvoicesForTenant,
} from '../../lib/api/billing'
import type { BillingPlan, BillingSubscription, PaymentInvoice, PaymentInvoiceStatus } from '../../types/domain'
import { Badge, Button, Card, CardSection, EmptyState, PageSpinner, Pagination, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'

const PAGE_SIZE = 8

const STATUS_LABEL: Record<PaymentInvoiceStatus, string> = {
  PENDING: 'Pendiente',
  PAID: 'Pagada',
  OVERDUE: 'Vencida',
  CANCELLED: 'Cancelada',
  REFUNDED: 'Reembolsada',
}

const STATUS_TONE: Record<PaymentInvoiceStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  PENDING: 'warning',
  PAID: 'success',
  OVERDUE: 'danger',
  CANCELLED: 'neutral',
  REFUNDED: 'neutral',
}

const SUBSCRIPTION_STATUS_LABEL: Record<BillingSubscription['status'], string> = {
  ACTIVE: 'Activa',
  CANCELLED: 'Cancelada',
  PAST_DUE: 'En mora',
  EXPIRED: 'Vencida',
  PENDING_PAYMENT: 'Pendiente de pago',
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })
}

function PayButton({ invoice }: { invoice: PaymentInvoice }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePay() {
    setLoading(true)
    setError(null)
    try {
      const checkoutUrl = await createCheckoutForInvoice(invoice.id, window.location.href)
      window.open(checkoutUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar el enlace de pago.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="text-right">
      <Button variant="secondary" onClick={handlePay} disabled={loading} className="!px-3 !py-1.5 text-xs">
        {loading ? 'Generando…' : 'Pagar ahora'}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export function Facturacion() {
  const { profile } = useAuth()
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
      .catch((err) => setError(err.message ?? 'No se pudo cargar tu plan.'))
    listInvoicesForTenant(tenantId)
      .then(setInvoices)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar tus facturas.'))
    listBillingPlans().then(setPlans).catch(() => setPlans([]))
  }, [tenantId])

  const plan = plans?.find((p) => p.id === subscription?.plan_id)
  const totalPages = invoices ? Math.max(1, Math.ceil(invoices.length / PAGE_SIZE)) : 1
  const pageItems = invoices ? invoices.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  if (!tenantId) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-4">
      <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">Facturación</h1>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <Card padded={false}>
        <CardSection title="Tu plan">
          {subscription === undefined && <PageSpinner />}
          {subscription === null && <EmptyState>Todavía no tienes un plan asignado. Contacta a Leadly para activar tu suscripción.</EmptyState>}
          {subscription && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <span className="font-medium text-brand-800">{plan?.name ?? 'Plan'}</span>
                <span className="ml-2 text-brand-400">
                  {plan ? `${formatMoney(plan.amount_cents, plan.currency)}/${plan.billing_interval === 'monthly' ? 'mes' : 'año'}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-brand-400">Próximo vencimiento: {formatDate(subscription.current_period_end)}</span>
                <Badge tone={subscription.status === 'ACTIVE' ? 'success' : subscription.status === 'PENDING_PAYMENT' ? 'warning' : 'danger'}>
                  {SUBSCRIPTION_STATUS_LABEL[subscription.status]}
                </Badge>
              </div>
            </div>
          )}
        </CardSection>

        <CardSection title="Historial de facturas">
          {!invoices && <PageSpinner />}
          {invoices && invoices.length === 0 && <EmptyState>Todavía no tienes facturas.</EmptyState>}
          {pageItems && pageItems.length > 0 && (
            <>
              <Table bare>
                <THead>
                  <tr>
                    <TH>Factura</TH>
                    <TH>Monto</TH>
                    <TH>Estado</TH>
                    <TH>Vence</TH>
                    <TH className="text-right">Acciones</TH>
                  </tr>
                </THead>
                <TBody>
                  {pageItems.map((invoice) => (
                    <TRow key={invoice.id}>
                      <TD className="font-medium text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</TD>
                      <TD>{formatMoney(invoice.amount_cents, invoice.currency)}</TD>
                      <TD>
                        <Badge tone={STATUS_TONE[invoice.status]}>{STATUS_LABEL[invoice.status]}</Badge>
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
