import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listAllInvoices } from '../../../lib/api/billing'
import type { PaymentInvoice, PaymentInvoiceStatus, PaymentInvoiceWithTenant } from '../../../types/domain'
import { Badge, Button, PageSpinner, Select, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { FilterIcon, SearchIcon } from '@/components/atoms/icons'
import { ManualPaymentDrawer } from './ManualPaymentDrawer'
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDate } from '../../../lib/dates'

const PAGE_SIZE = 10

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

export function InvoicesSection() {
  const { t } = useLanguage()
  const [invoices, setInvoices] = useState<PaymentInvoiceWithTenant[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<PaymentInvoiceStatus | ''>('')
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [paymentDrawer, setPaymentDrawer] = useState<PaymentInvoice | null>(null)
  const [detailDrawer, setDetailDrawer] = useState<PaymentInvoice | null>(null)
  const filtersRef = useRef<HTMLDivElement>(null)

  function reload() {
    listAllInvoices()
      .then(setInvoices)
      .catch((err) => setError(err.message ?? t('backoffice.invoicesSection.errors.load')))
  }

  useEffect(reload, [])

  useEffect(() => {
    if (!filtersOpen) return
    function handleClick(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [filtersOpen])

  const filtered = useMemo(() => {
    if (!invoices) return null
    const term = search.trim().toLowerCase()
    return invoices.filter((inv) => {
      if (statusFilter && inv.status !== statusFilter) return false
      if (!term) return true
      return (inv.tenant?.name ?? '').toLowerCase().includes(term) || (inv.invoice_number ?? '').toLowerCase().includes(term)
    })
  }, [invoices, search, statusFilter])

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null
  const hasActiveFilters = !!search || !!statusFilter

  const pendingTotalCents = useMemo(
    () => (invoices ?? []).filter((i) => i.status === 'PENDING' || i.status === 'OVERDUE').reduce((sum, i) => sum + i.amount_cents, 0),
    [invoices],
  )
  const overdueCount = useMemo(() => (invoices ?? []).filter((i) => i.status === 'OVERDUE').length, [invoices])
  const paidThisMonthCents = useMemo(() => {
    const now = new Date()
    return (invoices ?? [])
      .filter((i) => i.status === 'PAID' && new Date(i.updated_at).getMonth() === now.getMonth() && new Date(i.updated_at).getFullYear() === now.getFullYear())
      .reduce((sum, i) => sum + i.amount_cents, 0)
  }, [invoices])

  function handleUpdated(updated: PaymentInvoice) {
    setInvoices((prev) => (prev ? prev.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)) : prev))
  }

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="!p-4">
          <p className="text-xs text-brand-400">{t('backoffice.invoicesSection.stats.pending')}</p>
          <p className="mt-1 text-lg font-bold text-brand-800">{invoices ? formatMoney(pendingTotalCents, 'COP') : '—'}</p>
        </Card>
        <Card className="!p-4">
          <p className="text-xs text-brand-400">{t('backoffice.invoicesSection.stats.overdue')}</p>
          <p className="mt-1 text-lg font-bold text-brand-800">{invoices ? overdueCount : '—'}</p>
        </Card>
        <Card className="!p-4">
          <p className="text-xs text-brand-400">{t('backoffice.invoicesSection.stats.paidThisMonth')}</p>
          <p className="mt-1 text-lg font-bold text-brand-800">{invoices ? formatMoney(paidThisMonthCents, 'COP') : '—'}</p>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-full max-w-[220px] sm:w-auto">
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            placeholder={t('backoffice.invoicesSection.search.placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="!py-1.5 !pl-8 text-sm"
          />
        </div>

        <div ref={filtersRef} className="relative">
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              hasActiveFilters ? 'border-accent-300 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-600 hover:bg-brand-50'
            }`}
          >
            <FilterIcon width={14} height={14} />
            {t('backoffice.invoicesSection.filters.label')}
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </button>

          {filtersOpen && (
            <div className="absolute left-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-brand-100 bg-white p-4 shadow-lg">
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('backoffice.invoicesSection.filters.status.label')}</label>
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PaymentInvoiceStatus | '')} className="!py-1.5 text-sm">
                  <option value="">{t('backoffice.invoicesSection.filters.status.all')}</option>
                  {(Object.keys(STATUS_LABEL_KEY) as PaymentInvoiceStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {t(STATUS_LABEL_KEY[s])}
                    </option>
                  ))}
                </Select>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('')
                    setStatusFilter('')
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-700"
                >
                  {t('backoffice.invoicesSection.filters.clear')}
                </button>
              )}
            </div>
          )}
        </div>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {t((filtered?.length ?? 0) === 1 ? 'backoffice.invoicesSection.count.singular' : 'backoffice.invoicesSection.count.plural')}
        </span>
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!invoices && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>{invoices && invoices.length > 0 ? t('backoffice.invoicesSection.emptyState.noMatch') : t('backoffice.invoicesSection.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <TH>{t('backoffice.invoicesSection.table.invoice')}</TH>
                <TH>{t('backoffice.invoicesSection.table.tenant')}</TH>
                <TH>{t('backoffice.invoicesSection.table.amount')}</TH>
                <TH>{t('backoffice.invoicesSection.table.status')}</TH>
                <TH className="hidden sm:table-cell">{t('backoffice.invoicesSection.table.due')}</TH>
                <TH className="text-right">{t('backoffice.invoicesSection.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((invoice) => (
                <TRow key={invoice.id} clickable onClick={() => setDetailDrawer(invoice)}>
                  <TD className="font-medium text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</TD>
                  <TD onClick={(e) => e.stopPropagation()}>
                    <Link to={`/backoffice/clients/${invoice.payer_tenant_id}`} className="text-brand-600 hover:text-accent-600">
                      {invoice.tenant?.name ?? '—'}
                    </Link>
                  </TD>
                  <TD>{formatMoney(invoice.amount_cents, invoice.currency)}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[invoice.status]}>{t(STATUS_LABEL_KEY[invoice.status])}</Badge>
                  </TD>
                  <TD className="hidden sm:table-cell text-brand-400">{formatDate(invoice.due_date)}</TD>
                  <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                    <span className="inline-flex items-center gap-1">
                      {(invoice.status === 'PENDING' || invoice.status === 'OVERDUE') && (
                        <Button variant="ghost" onClick={() => setPaymentDrawer(invoice)} className="!px-2.5 !py-1.5 text-xs">
                          {t('backoffice.invoicesSection.recordPayment')}
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setDetailDrawer(invoice)} className="!px-2.5 !py-1.5 text-xs">
                        {t('backoffice.invoicesSection.viewDetail')}
                      </Button>
                    </span>
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <ManualPaymentDrawer
        open={!!paymentDrawer}
        onClose={() => setPaymentDrawer(null)}
        invoice={paymentDrawer}
        onRecorded={(updated) => {
          handleUpdated(updated)
          setPaymentDrawer(null)
        }}
      />
      <InvoiceDetailDrawer open={!!detailDrawer} onClose={() => setDetailDrawer(null)} invoice={detailDrawer} />
    </>
  )
}
