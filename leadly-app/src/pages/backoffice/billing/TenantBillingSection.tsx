import { useEffect, useState } from 'react'
import { createManualInvoice, getActiveSubscriptionForTenant, listInvoicesForTenant, type ManualInvoiceItemInput } from '../../../lib/api/billing'
import type { PaymentInvoice, PaymentInvoiceStatus } from '../../../types/domain'
import { Button, Badge, Input, Label, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { CardSection, CurrencyInput, EmptyState } from '@/components/molecules'
import { PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { ManualPaymentDrawer } from './ManualPaymentDrawer'
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDate } from '../../../lib/dates'

const STATUS_LABEL_KEY: Record<PaymentInvoiceStatus, TranslationKey> = {
  PENDING: 'backoffice.tenantBilling.invoiceStatus.pending',
  PAID: 'backoffice.tenantBilling.invoiceStatus.paid',
  OVERDUE: 'backoffice.tenantBilling.invoiceStatus.overdue',
  CANCELLED: 'backoffice.tenantBilling.invoiceStatus.cancelled',
  REFUNDED: 'backoffice.tenantBilling.invoiceStatus.refunded',
}

const STATUS_TONE: Record<PaymentInvoiceStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  PENDING: 'warning',
  PAID: 'success',
  OVERDUE: 'danger',
  CANCELLED: 'neutral',
  REFUNDED: 'neutral',
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

interface ItemDraft {
  description: string
  quantity: string
  unitPrice: string
}

const EMPTY_ITEM: ItemDraft = { description: '', quantity: '1', unitPrice: '' }

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
  const { t } = useLanguage()
  const [items, setItems] = useState<ItemDraft[]>([{ ...EMPTY_ITEM }])
  const [dueDate, setDueDate] = useState('')
  const [taxRate, setTaxRate] = useState('19')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateItem(index: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const validItems: ManualInvoiceItemInput[] = items
    .filter((item) => item.description.trim() && Number(item.unitPrice) > 0)
    .map((item) => ({
      description: item.description.trim(),
      quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
      unitPriceCents: Math.round(Number(item.unitPrice) * 100),
    }))
  const totalCents = validItems.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPriceCents), 0)

  async function handleSubmit() {
    if (validItems.length === 0) {
      setError(t('backoffice.tenantBilling.manualInvoice.errors.items'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const invoice = await createManualInvoice({
        payerTenantId: tenantId,
        subscriptionId,
        providerKey: 'wompi',
        currency: 'COP',
        dueDate: dueDate || null,
        taxRate: taxRate === '' ? undefined : Number(taxRate),
        items: validItems,
      })
      onCreated(invoice)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.tenantBilling.manualInvoice.errors.create'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-brand-100 p-3">
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_7rem_auto] items-end gap-2">
            <div>
              {i === 0 && <Label htmlFor={`manual-invoice-item-desc-${i}`}>{t('backoffice.tenantBilling.manualInvoice.itemDescription')}</Label>}
              <Input
                id={`manual-invoice-item-desc-${i}`}
                value={item.description}
                onChange={(e) => updateItem(i, { description: e.target.value })}
                placeholder={t('backoffice.tenantBilling.manualInvoice.defaultDescription')}
              />
            </div>
            <div>
              {i === 0 && <Label htmlFor={`manual-invoice-item-qty-${i}`}>{t('backoffice.tenantBilling.manualInvoice.itemQuantity')}</Label>}
              <Input
                id={`manual-invoice-item-qty-${i}`}
                type="number"
                min={1}
                step={1}
                value={item.quantity}
                onChange={(e) => updateItem(i, { quantity: e.target.value })}
              />
            </div>
            <div>
              {i === 0 && <Label htmlFor={`manual-invoice-item-price-${i}`}>{t('backoffice.tenantBilling.manualInvoice.itemUnitPrice')}</Label>}
              <CurrencyInput
                id={`manual-invoice-item-price-${i}`}
                min={1}
                step={1}
                value={item.unitPrice}
                onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                placeholder="50000"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => removeItem(i)}
              disabled={items.length === 1}
              className="!px-2.5 !py-2.5 text-xs !text-red-600"
              aria-label={t('backoffice.tenantBilling.manualInvoice.removeItem')}
            >
              <TrashIcon width={14} height={14} />
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])} className="!px-2.5 !py-1.5 text-xs">
          <PlusIcon width={13} height={13} /> {t('backoffice.tenantBilling.manualInvoice.addItem')}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="manual-invoice-due-date">{t('backoffice.tenantBilling.manualInvoice.dueDate')}</Label>
          <Input id="manual-invoice-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="manual-invoice-tax-rate">{t('backoffice.tenantBilling.manualInvoice.taxRate')}</Label>
          <Input id="manual-invoice-tax-rate" type="number" min={0} max={100} step={0.5} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
        </div>
        <div className="flex flex-col justify-end">
          <p className="text-xs text-brand-400">{t('backoffice.tenantBilling.manualInvoice.total')}</p>
          <p className="text-sm font-semibold text-brand-800">{formatMoney(totalCents, 'COP')}</p>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={handleSubmit} disabled={submitting} className="!px-3 !py-1.5 text-xs">
          {submitting ? t('backoffice.tenantBilling.manualInvoice.creating') : t('backoffice.tenantBilling.manualInvoice.create')}
        </Button>
        <Button variant="ghost" onClick={onCancel} className="!px-3 !py-1.5 text-xs">
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  )
}

export function TenantBillingSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  // Only the subscription id is needed here (to link a manual invoice to it)
  // -- the plan itself (assign/change/cancel) now lives in the client detail
  // sidebar (TenantPlanSection), not in this invoices/payments tab.
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<PaymentInvoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [manualInvoiceOpen, setManualInvoiceOpen] = useState(false)
  const [paymentDrawerInvoice, setPaymentDrawerInvoice] = useState<PaymentInvoice | null>(null)
  const [detailDrawerInvoice, setDetailDrawerInvoice] = useState<PaymentInvoice | null>(null)

  function reload() {
    getActiveSubscriptionForTenant(tenantId)
      .then((sub) => setSubscriptionId(sub?.id ?? null))
      .catch(() => setSubscriptionId(null))
    listInvoicesForTenant(tenantId)
      .then(setInvoices)
      .catch((err) => setError(err.message ?? t('backoffice.tenantBilling.errors.loadInvoices')))
  }

  useEffect(reload, [tenantId])

  return (
    <CardSection
      title={t('backoffice.tenantBilling.title')}
      action={
        <Button variant="secondary" onClick={() => setManualInvoiceOpen((v) => !v)} className="!px-3 !py-1.5 text-xs">
          <PlusIcon width={14} height={14} /> {t('backoffice.tenantBilling.manualInvoice.toggle')}
        </Button>
      }
    >
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {manualInvoiceOpen && (
        <ManualInvoiceForm
          tenantId={tenantId}
          subscriptionId={subscriptionId}
          onCreated={(invoice) => {
            setInvoices((prev) => [invoice, ...(prev ?? [])])
            setManualInvoiceOpen(false)
          }}
          onCancel={() => setManualInvoiceOpen(false)}
        />
      )}

      {!invoices && <PageSpinner />}
      {invoices && invoices.length === 0 && <EmptyState>{t('backoffice.tenantBilling.invoicesEmpty')}</EmptyState>}
      {invoices && invoices.length > 0 && (
        <Table bare>
          <THead>
            <tr>
              <TH>{t('backoffice.tenantBilling.table.invoice')}</TH>
              <TH>{t('backoffice.tenantBilling.table.amount')}</TH>
              <TH>{t('backoffice.tenantBilling.table.status')}</TH>
              <TH>{t('backoffice.tenantBilling.table.due')}</TH>
              <TH className="text-right">{t('backoffice.tenantBilling.table.actions')}</TH>
            </tr>
          </THead>
          <TBody>
            {invoices.map((invoice) => (
              <TRow key={invoice.id} clickable onClick={() => setDetailDrawerInvoice(invoice)}>
                <TD className="font-medium text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</TD>
                <TD>{formatMoney(invoice.amount_cents, invoice.currency)}</TD>
                <TD>
                  <Badge tone={STATUS_TONE[invoice.status]}>{t(STATUS_LABEL_KEY[invoice.status])}</Badge>
                </TD>
                <TD className="text-brand-400">{formatDate(invoice.due_date)}</TD>
                <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                  <span className="inline-flex items-center gap-1">
                    {(invoice.status === 'PENDING' || invoice.status === 'OVERDUE') && (
                      <Button variant="ghost" onClick={() => setPaymentDrawerInvoice(invoice)} className="!px-2.5 !py-1.5 text-xs">
                        {t('backoffice.tenantBilling.recordPayment')}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setDetailDrawerInvoice(invoice)} className="!px-2.5 !py-1.5 text-xs">
                      {t('backoffice.invoicesSection.viewDetail')}
                    </Button>
                  </span>
                </TD>
              </TRow>
            ))}
          </TBody>
        </Table>
      )}

      <ManualPaymentDrawer
        open={!!paymentDrawerInvoice}
        onClose={() => setPaymentDrawerInvoice(null)}
        invoice={paymentDrawerInvoice}
        onRecorded={(updated) => {
          setInvoices((prev) => (prev ? prev.map((i) => (i.id === updated.id ? updated : i)) : prev))
          setPaymentDrawerInvoice(null)
        }}
      />

      <InvoiceDetailDrawer open={!!detailDrawerInvoice} onClose={() => setDetailDrawerInvoice(null)} invoice={detailDrawerInvoice} />
    </CardSection>
  )
}
