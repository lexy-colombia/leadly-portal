import { useEffect, useState, type ReactNode } from 'react'
import { listAttemptsForInvoice, listItemsForInvoice } from '../../../lib/api/billing'
import type { PaymentAttempt, PaymentInvoice, PaymentInvoiceItem } from '../../../types/domain'
import { Badge, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatDateTime } from '../../../lib/dates'

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-brand-400">{label}</span>
      <span className="text-right text-brand-700">{value}</span>
    </div>
  )
}

/** Read-only view of everything a Colombian electronic invoice needs to be
 * issued by a certified provider later (buyer snapshot, IVA breakdown) plus
 * the real payment history -- makes the DIAN-ready data visible/useful
 * instead of sitting silently in columns nobody looks at. */
export function InvoiceDetailDrawer({ open, onClose, invoice }: { open: boolean; onClose: () => void; invoice: PaymentInvoice | null }) {
  const { t, language } = useLanguage()
  const [attempts, setAttempts] = useState<PaymentAttempt[] | null>(null)
  const [items, setItems] = useState<PaymentInvoiceItem[] | null>(null)

  useEffect(() => {
    if (!open || !invoice) return
    setAttempts(null)
    setItems(null)
    listAttemptsForInvoice(invoice.id).then(setAttempts).catch(() => setAttempts([]))
    listItemsForInvoice(invoice.id).then(setItems).catch(() => setItems([]))
  }, [open, invoice])

  if (!invoice) return null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('backoffice.invoiceDetail.title', { invoice: invoice.invoice_number ?? invoice.id.slice(0, 8) })}
      description={invoice.description ?? ''}
    >
      <div className="space-y-5">
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-brand-400">{t('backoffice.invoiceDetail.buyer')}</h3>
          <dl className="divide-y divide-brand-50">
            <Row label={t('backoffice.invoiceDetail.buyer.legalName')} value={invoice.buyer_legal_name ?? '—'} />
            <Row
              label={t('backoffice.invoiceDetail.buyer.document')}
              value={invoice.buyer_document_number ? `${invoice.buyer_document_type ?? ''} ${invoice.buyer_document_number}` : '—'}
            />
            <Row label={t('backoffice.invoiceDetail.buyer.email')} value={invoice.buyer_email ?? '—'} />
            <Row label={t('backoffice.invoiceDetail.buyer.address')} value={invoice.buyer_address ?? '—'} />
          </dl>
        </section>

        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-brand-400">{t('backoffice.invoiceDetail.items')}</h3>
          {items === null && <PageSpinner />}
          {items && items.length === 0 && <p className="text-sm text-brand-400">{t('backoffice.invoiceDetail.items.empty')}</p>}
          {items && items.length > 0 && (
            <Table bare>
              <THead>
                <tr>
                  <TH>{t('backoffice.invoiceDetail.items.description')}</TH>
                  <TH className="text-right">{t('backoffice.invoiceDetail.items.quantity')}</TH>
                  <TH className="text-right">{t('backoffice.invoiceDetail.items.unitPrice')}</TH>
                  <TH className="text-right">{t('backoffice.invoiceDetail.items.subtotal')}</TH>
                </tr>
              </THead>
              <TBody>
                {items.map((item) => (
                  <TRow key={item.id}>
                    <TD>{item.description}</TD>
                    <TD className="text-right">{item.quantity}</TD>
                    <TD className="text-right">{formatMoney(item.unit_price_cents, invoice.currency)}</TD>
                    <TD className="text-right">{formatMoney(item.subtotal_cents, invoice.currency)}</TD>
                  </TRow>
                ))}
              </TBody>
            </Table>
          )}
        </section>

        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-brand-400">{t('backoffice.invoiceDetail.amounts')}</h3>
          <dl className="divide-y divide-brand-50">
            <Row label={t('backoffice.invoiceDetail.subtotal')} value={invoice.subtotal_cents !== null ? formatMoney(invoice.subtotal_cents, invoice.currency) : '—'} />
            <Row
              label={t('backoffice.invoiceDetail.tax', { rate: invoice.tax_rate })}
              value={invoice.tax_cents !== null ? formatMoney(invoice.tax_cents, invoice.currency) : '—'}
            />
            <Row label={t('backoffice.invoiceDetail.total')} value={<span className="font-semibold">{formatMoney(invoice.amount_cents, invoice.currency)}</span>} />
          </dl>
        </section>

        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-brand-400">{t('backoffice.invoiceDetail.payments')}</h3>
          {attempts === null && <PageSpinner />}
          {attempts && attempts.length === 0 && <p className="text-sm text-brand-400">{t('backoffice.invoiceDetail.payments.empty')}</p>}
          {attempts && attempts.length > 0 && (
            <ul className="space-y-2">
              {attempts.map((a) => (
                <li key={a.id} className="rounded-lg border border-brand-100 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-brand-800">
                      {a.provider_key === 'manual' ? t('backoffice.invoiceDetail.payments.manual') : a.provider_key}
                    </span>
                    <Badge tone={a.status === 'APPROVED' ? 'success' : 'neutral'}>{a.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-brand-400">
                    {a.amount_cents !== null ? formatMoney(a.amount_cents, a.currency ?? invoice.currency) : ''} · {formatDateTime(a.created_at, language)}
                  </p>
                  {a.payment_reference && <p className="mt-0.5 text-xs text-brand-500">{a.payment_reference}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}
