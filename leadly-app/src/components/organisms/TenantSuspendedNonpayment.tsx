import { useEffect, useState } from 'react'
import { useLanguage } from '@/contexts/LanguageContext'
import { formatDate } from '@/lib/dates'
import { listInvoicesForTenant } from '@/lib/api/billing'
import type { PaymentInvoice } from '@/types/domain'
import { Button } from '@/components/atoms/Button'
import { PageSpinner } from '@/components/atoms'
import { InvoicePayButton } from '@/components/molecules/InvoicePayButton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountCents / 100)
}

/** Muro de pago: reemplaza TODA la app cuando el tenant esta bloqueado por mora
 * (suspension_reason = 'nonpayment'). Solo muestra los comprobantes del propio tenant, leidos con el JWT
 * del usuario (la RLS del backend decide que ve); el frontend no valida reglas de cobro: el boton "Pagar"
 * pide el checkout al backend y muestra su respuesta/error, y el desbloqueo lo hace el servidor al
 * acreditar el pago ("Ya pague, verificar" solo vuelve a leer el estado del tenant). */
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
      setInvoices(rows.filter((i) => i.status === 'PENDING' || i.status === 'OVERDUE'))
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

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xs font-semibold text-brand-700">{t('billing.wall.title')}</h2>
      <p className="max-w-md text-xs text-brand-400">
        {tenantName ? t('billing.wall.description', { name: tenantName }) : t('billing.wall.descriptionNoName')}
      </p>

      <div className="w-full max-w-3xl text-left">
        <h3 className="mb-1 text-xs font-semibold text-brand-700">{t('billing.wall.invoicesTitle')}</h3>
        <p className="mb-2 text-xs text-brand-400">{t('billing.wall.notElectronic')}</p>
        {loadError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t('billing.wall.loadError')}</p>}
        {!loadError && !invoices && <PageSpinner />}
        {!loadError && invoices && invoices.length === 0 && <p className="text-xs text-brand-400">{t('billing.wall.empty')}</p>}
        {invoices && invoices.length > 0 && (
          <div className="overflow-x-auto rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('billing.invoices.table.invoice')}</TableHead>
                  <TableHead>{t('billing.wall.table.plan')}</TableHead>
                  <TableHead>{t('billing.invoices.table.period')}</TableHead>
                  <TableHead>{t('billing.invoices.table.amount')}</TableHead>
                  <TableHead>{t('billing.invoices.table.dueDate')}</TableHead>
                  <TableHead className="text-right">{t('billing.invoices.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-medium text-brand-800">{invoice.invoice_number ?? invoice.id.slice(0, 8)}</TableCell>
                    <TableCell className="text-brand-400">{invoice.description ?? '—'}</TableCell>
                    <TableCell className="text-brand-400">
                      {invoice.period_start && invoice.period_end ? `${formatDate(invoice.period_start)} → ${formatDate(invoice.period_end)}` : '—'}
                    </TableCell>
                    <TableCell>{formatMoney(invoice.amount_cents, invoice.currency)}</TableCell>
                    <TableCell className="text-brand-400">{formatDate(invoice.due_date)}</TableCell>
                    <TableCell>
                      <InvoicePayButton invoiceId={invoice.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <p className="max-w-md text-xs text-brand-400">{t('billing.wall.autoReactivate')}</p>
      {stillSuspended && <p className="max-w-md rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('billing.wall.stillSuspended')}</p>}
      <div className="flex items-center gap-2">
        <Button onClick={handleVerify} disabled={verifying}>
          {verifying ? t('billing.wall.verifying') : t('billing.wall.verify')}
        </Button>
        <Button variant="ghost" onClick={onSignOut}>
          {t('billing.wall.signOut')}
        </Button>
      </div>
      <p className="max-w-md text-xs text-brand-400">{t('billing.wall.contact')}</p>
    </div>
  )
}
