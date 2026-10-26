import { useEffect, useState } from 'react'
import { AlertCircle, FileText, LogOut, RefreshCw } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { formatDate } from '@/lib/dates'
import { listInvoicesForTenant } from '@/lib/api/billing'
import type { PaymentInvoice } from '@/types/domain'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/atoms/Logo'
import { PageSpinner } from '@/components/atoms'
import { InvoicePayButton } from '@/components/molecules/InvoicePayButton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

function initials(name: string | undefined): string {
  if (!name) return '·'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·'
}

/** Muro de pago: reemplaza TODA la app cuando el tenant esta bloqueado por mora
 * (suspension_reason = 'nonpayment'). Solo muestra los comprobantes del propio tenant, leidos con el JWT
 * del usuario (la RLS del backend decide que ve); el frontend no valida reglas de cobro: el boton "Pagar"
 * pide el checkout al backend y muestra su respuesta/error, y el desbloqueo lo hace el servidor al
 * acreditar el pago ("Verificar pago" solo vuelve a leer el estado del tenant). */
export function TenantSuspendedNonpayment({
  tenantId,
  tenantName,
  onSignOut,
  onRefresh,
}: {
  tenantId: string
  tenantName: string | undefined
  onSignOut: () => void
  onRefresh: () => Promise<void>
}) {
  const { t } = useLanguage()
  const [invoices, setInvoices] = useState<PaymentInvoice[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [stillSuspended, setStillSuspended] = useState(false)

  async function loadInvoices() {
    try {
      const rows = await listInvoicesForTenant(tenantId)
      const pending = rows
        .filter((i) => i.status === 'PENDING' || i.status === 'OVERDUE')
        .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
      setInvoices(pending)
      setLoadError(false)
    } catch (err) {
      console.error('Failed to load invoices for the payment wall', err)
      setLoadError(true)
    }
  }

  useEffect(() => {
    void loadInvoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  async function handleVerify() {
    setVerifying(true)
    setStillSuspended(false)
    try {
      await onRefresh()
      // Si el servidor ya reactivo al tenant, este componente se desmonta. Si seguimos aqui, aun no.
      setStillSuspended(true)
      await loadInvoices()
    } finally {
      setVerifying(false)
    }
  }

  const hasInvoices = !!invoices && invoices.length > 0
  const several = !!invoices && invoices.length > 1
  const currency = invoices?.[0]?.currency ?? 'COP'
  const totalCents = (invoices ?? []).reduce((sum, i) => sum + i.amount_cents, 0)
  const first = invoices?.[0]

  return (
    <div className="flex min-h-screen w-full flex-col bg-brand-50/40">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-brand-100 bg-white px-4 sm:px-8">
        <Logo size="md" />
        <div className="flex items-center gap-3">
          {tenantName && <span className="hidden text-sm font-medium text-brand-700 sm:inline">{tenantName}</span>}
          <span className="flex size-9 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
            {initials(tenantName)}
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8 sm:py-12">
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-brand-400 uppercase">{t('billing.wall.eyebrow')}</p>
          <h1 className="mt-2 text-2xl font-bold text-brand-800 sm:text-3xl">{t('billing.wall.title')}</h1>
          <p className="mt-2 text-sm text-brand-400 sm:text-base">
            {tenantName ? t('billing.wall.description', { name: tenantName }) : t('billing.wall.descriptionNoName')}
          </p>
        </div>

        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-semibold text-red-700">{t('billing.wall.alertTitle')}</p>
            <p className="text-sm text-red-700/90">{t('billing.wall.alertBody')}</p>
          </div>
        </div>

        <div className="grid items-start gap-5 lg:grid-cols-[1fr_340px]">
          <section className="rounded-2xl border border-brand-100 bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-brand-100 px-5 py-4 sm:px-6">
              <div>
                <h2 className="text-base font-semibold text-brand-800">{t('billing.wall.invoicesTitle')}</h2>
                <p className="mt-0.5 text-xs text-brand-400">{t('billing.wall.invoicesSubtitle')}</p>
              </div>
              {hasInvoices && (
                <span className="shrink-0 rounded-md bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                  {t(invoices.length === 1 ? 'billing.wall.pendingOne' : 'billing.wall.pendingMany', { count: invoices.length })}
                </span>
              )}
            </div>

            <div className="px-5 py-5 sm:px-6">
              {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t('billing.wall.loadError')}</p>}
              {!loadError && !invoices && <PageSpinner />}
              {!loadError && invoices && invoices.length === 0 && <p className="text-sm text-brand-400">{t('billing.wall.empty')}</p>}
              {hasInvoices && (
                <div className="overflow-x-auto rounded-xl border border-brand-100">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-brand-50/60">
                        <TableHead>{t('billing.invoices.table.invoice')}</TableHead>
                        <TableHead>{t('billing.invoices.table.period')}</TableHead>
                        <TableHead>{t('billing.invoices.table.dueDate')}</TableHead>
                        <TableHead className="text-right">{t('billing.invoices.table.amount')}</TableHead>
                        {several && <TableHead className="text-right" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoices.map((invoice) => (
                        <TableRow key={invoice.id}>
                          <TableCell>
                            <p className="font-semibold text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</p>
                            {invoice.description && <p className="text-xs text-brand-400">{invoice.description}</p>}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-brand-400">
                            {invoice.period_start && invoice.period_end
                              ? `${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}`
                              : '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <p className="text-brand-700">{formatDate(invoice.due_date)}</p>
                            {invoice.status === 'OVERDUE' && <p className="text-xs font-medium text-red-600">{t('billing.wall.overdue')}</p>}
                          </TableCell>
                          <TableCell className="text-right font-semibold whitespace-nowrap text-brand-800">
                            {formatMoney(invoice.amount_cents, invoice.currency)}
                          </TableCell>
                          {several && (
                            <TableCell>
                              <InvoicePayButton invoiceId={invoice.id} />
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <p className="mt-4 flex items-center gap-2 text-xs text-brand-400">
                <FileText className="size-4 shrink-0" />
                {t('billing.wall.notElectronic')}
              </p>
            </div>
          </section>

          <aside className="rounded-2xl border border-brand-100 bg-white px-5 py-5 sm:px-6 lg:sticky lg:top-6">
            <h2 className="text-base font-semibold text-brand-800">{t('billing.wall.summaryTitle')}</h2>
            <div className="mt-4 flex items-center justify-between border-b border-brand-100 pb-4 text-sm text-brand-400">
              <span>{t('billing.wall.summaryPending')}</span>
              <span className="font-semibold text-brand-800">{invoices?.length ?? '—'}</span>
            </div>
            <p className="mt-4 text-xs font-medium text-brand-400">{t('billing.wall.totalToPay')}</p>
            <p className="mt-1 text-3xl font-bold text-brand-800">
              {invoices ? formatMoney(totalCents, currency).replace(/\s?COP$/, '') : '—'}
              {invoices && <span className="ml-1.5 text-xs font-medium text-brand-400">{currency}</span>}
            </p>
            {first && (
              <div className="mt-5">
                <InvoicePayButton invoiceId={first.id} variant="hero" />
                {several && (
                  <p className="mt-2 text-center text-xs text-brand-400">
                    {t('billing.wall.payFirstHint', { invoice: first.invoice_number ?? first.id.slice(0, 8) })}
                  </p>
                )}
              </div>
            )}
            <p className="mt-3 text-center text-xs text-brand-400">{t('billing.wall.autoReactivate')}</p>
          </aside>
        </div>

        <section className="flex flex-col gap-3 rounded-2xl border border-brand-100 bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-start gap-3">
            <RefreshCw className={`mt-0.5 size-5 shrink-0 text-brand-700 ${verifying ? 'animate-spin' : ''}`} />
            <div>
              <p className="text-sm font-semibold text-brand-800">{t('billing.wall.verifyTitle')}</p>
              <p className="text-xs text-brand-400">{t('billing.wall.verifyDescription')}</p>
            </div>
          </div>
          <Button variant="outline" onClick={handleVerify} disabled={verifying} className="h-9 px-4 text-sm font-semibold sm:shrink-0">
            {verifying ? t('billing.wall.verifying') : t('billing.wall.verify')}
          </Button>
        </section>
        {stillSuspended && (
          <p role="status" className="-mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {t('billing.wall.stillSuspended')}
          </p>
        )}

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-2 text-sm text-brand-400">
          <span>{t('billing.wall.contact')}</span>
          <button type="button" onClick={onSignOut} className="inline-flex items-center gap-2 font-medium text-brand-700 hover:text-brand-800">
            <LogOut className="size-4" />
            {t('billing.wall.signOut')}
          </button>
        </footer>
      </main>
    </div>
  )
}
