import { useEffect, useState } from 'react'
import {
  assignTenantToPlan,
  createManualInvoice,
  getActiveSubscriptionForTenant,
  listBillingPlans,
  listInvoicesForTenant,
} from '../../../lib/api/billing'
import type { BillingPlan, BillingSubscription, PaymentInvoice, PaymentInvoiceStatus } from '../../../types/domain'
import { Badge, Button, CardSection, CurrencyInput, EmptyState, Input, Label, PageSpinner, Select, Table, TBody, TD, TH, THead, TRow } from '../../../components/ui'
import { PlusIcon } from '../../../components/icons'

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

function ManualInvoiceForm({
  tenantId,
  subscriptionId,
  onCreated,
  onCancel,
}: {
  tenantId: string
  subscriptionId: string | null
  onCreated: (invoice: PaymentInvoice) => void
  onCancel: () => void
}) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    const parsedAmount = Number(amount)
    if (!parsedAmount || parsedAmount <= 0) {
      setError('Ingresa un monto válido.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const invoice = await createManualInvoice({
        payerTenantId: tenantId,
        subscriptionId,
        providerKey: 'wompi',
        amountCents: Math.round(parsedAmount * 100),
        currency: 'COP',
        description: description.trim() || 'Factura Leadly',
        dueDate: dueDate || null,
      })
      onCreated(invoice)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la factura.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-brand-100 p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="manual-invoice-amount">Monto (COP)</Label>
          <CurrencyInput id="manual-invoice-amount" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50000" />
        </div>
        <div>
          <Label htmlFor="manual-invoice-description">Descripción</Label>
          <Input id="manual-invoice-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Factura Leadly" />
        </div>
        <div>
          <Label htmlFor="manual-invoice-due-date">Vence (opcional)</Label>
          <Input id="manual-invoice-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={handleSubmit} disabled={submitting} className="!px-3 !py-1.5 text-xs">
          {submitting ? 'Creando…' : 'Crear factura'}
        </Button>
        <Button variant="ghost" onClick={onCancel} className="!px-3 !py-1.5 text-xs">
          Cancelar
        </Button>
      </div>
    </div>
  )
}

export function TenantBillingSection({ tenantId }: { tenantId: string }) {
  const [subscription, setSubscription] = useState<BillingSubscription | null | undefined>(undefined)
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [invoices, setInvoices] = useState<PaymentInvoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [manualInvoiceOpen, setManualInvoiceOpen] = useState(false)

  function reload() {
    getActiveSubscriptionForTenant(tenantId)
      .then(setSubscription)
      .catch((err) => setError(err.message ?? 'No se pudo cargar la suscripción.'))
    listInvoicesForTenant(tenantId)
      .then(setInvoices)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar las facturas.'))
  }

  useEffect(reload, [tenantId])
  useEffect(() => {
    listBillingPlans().then(setPlans).catch(() => setPlans([]))
  }, [])

  async function handleAssignPlan() {
    if (!selectedPlanId) return
    setAssigning(true)
    setError(null)
    try {
      const sub = await assignTenantToPlan(tenantId, selectedPlanId)
      setSubscription(sub)
      setSelectedPlanId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo asignar el plan.')
    } finally {
      setAssigning(false)
    }
  }

  const plan = plans?.find((p) => p.id === subscription?.plan_id)

  return (
    <CardSection
      title="Facturación"
      action={
        <Button variant="secondary" onClick={() => setManualInvoiceOpen((v) => !v)} className="!px-3 !py-1.5 text-xs">
          <PlusIcon width={14} height={14} /> Factura manual
        </Button>
      }
    >
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mb-4 rounded-lg border border-brand-100 p-3">
        {subscription === undefined && <PageSpinner />}
        {subscription === null && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <Label htmlFor="assign-plan">Este cliente no tiene un plan asignado</Label>
              <Select id="assign-plan" value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}>
                <option value="">Selecciona un plan…</option>
                {plans
                  ?.filter((p) => p.is_active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatMoney(p.amount_cents, p.currency)}/{p.billing_interval === 'monthly' ? 'mes' : 'año'}
                    </option>
                  ))}
              </Select>
            </div>
            <Button variant="secondary" onClick={handleAssignPlan} disabled={!selectedPlanId || assigning} className="!px-3 !py-1.5 text-xs">
              {assigning ? 'Asignando…' : 'Asignar plan'}
            </Button>
          </div>
        )}
        {subscription && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-medium text-brand-800">{plan?.name ?? 'Plan'}</span>
              <span className="ml-2 text-brand-400">
                {plan ? `${formatMoney(plan.amount_cents, plan.currency)}/${plan.billing_interval === 'monthly' ? 'mes' : 'año'}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-brand-400">Vence: {formatDate(subscription.current_period_end)}</span>
              <Badge tone={subscription.status === 'ACTIVE' ? 'success' : subscription.status === 'PENDING_PAYMENT' ? 'warning' : 'danger'}>
                {SUBSCRIPTION_STATUS_LABEL[subscription.status]}
              </Badge>
            </div>
          </div>
        )}
      </div>

      {manualInvoiceOpen && (
        <ManualInvoiceForm
          tenantId={tenantId}
          subscriptionId={subscription?.id ?? null}
          onCreated={(invoice) => {
            setInvoices((prev) => [invoice, ...(prev ?? [])])
            setManualInvoiceOpen(false)
          }}
          onCancel={() => setManualInvoiceOpen(false)}
        />
      )}

      {!invoices && <PageSpinner />}
      {invoices && invoices.length === 0 && <EmptyState>Este cliente todavía no tiene facturas.</EmptyState>}
      {invoices && invoices.length > 0 && (
        <Table bare>
          <THead>
            <tr>
              <TH>Factura</TH>
              <TH>Monto</TH>
              <TH>Estado</TH>
              <TH>Vence</TH>
            </tr>
          </THead>
          <TBody>
            {invoices.map((invoice) => (
              <TRow key={invoice.id}>
                <TD className="font-medium text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</TD>
                <TD>{formatMoney(invoice.amount_cents, invoice.currency)}</TD>
                <TD>
                  <Badge tone={STATUS_TONE[invoice.status]}>{STATUS_LABEL[invoice.status]}</Badge>
                </TD>
                <TD className="text-brand-400">{formatDate(invoice.due_date)}</TD>
              </TRow>
            ))}
          </TBody>
        </Table>
      )}
    </CardSection>
  )
}
