import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { listCreditClients, type ClientCreditSummary } from '../../lib/api/credit'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const PAGE_SIZE = 10

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** "Cartera": every client with credit_enabled and their balance -- the
 * portfolio-wide view, as opposed to the per-client "Crédito" tab on
 * ClientDetail.tsx (which is the ledger for one client). Row click deep-
 * links into that tab via ?tab=credito, same criterion as Opportunities'
 * ?account=<id> breadcrumb. */
export function Credit() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [summaries, setSummaries] = useState<ClientCreditSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  useEffect(() => {
    if (!profile?.tenant_id) return
    listCreditClients(profile.tenant_id)
      .then(setSummaries)
      .catch((err) => setError(err instanceof Error ? err.message : t('credit.errors.load')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.tenant_id])

  const totalPages = summaries ? Math.max(1, Math.ceil(summaries.length / PAGE_SIZE)) : 1
  const pageItems = useMemo(() => (summaries ? summaries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null), [summaries, page])

  const totals = useMemo(() => {
    if (!summaries) return null
    return summaries.reduce(
      (acc, { totalCharged, totalPaid, balance }) => ({
        totalCharged: acc.totalCharged + totalCharged,
        totalPaid: acc.totalPaid + totalPaid,
        totalBalance: acc.totalBalance + balance,
        withBalance: acc.withBalance + (balance > 0 ? 1 : 0),
      }),
      { totalCharged: 0, totalPaid: 0, totalBalance: 0, withBalance: 0 },
    )
  }, [summaries])

  return (
    <div className="space-y-4">
      {summaries && totals && (
        <div className="grid grid-cols-2 divide-x divide-y divide-brand-100 overflow-hidden rounded-2xl border border-brand-100 bg-white sm:grid-cols-5 sm:divide-y-0">
          <div className="px-4 py-3">
            <p className="text-xs text-brand-400">{t('credit.summary.clients')}</p>
            <p className="text-lg font-bold text-brand-800">{summaries.length}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-brand-400">{t('credit.summary.withBalance')}</p>
            <p className="text-lg font-bold text-brand-800">{totals.withBalance}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-brand-400">{t('credit.table.charged')}</p>
            <p className="text-lg font-bold text-brand-800">{formatCurrency(totals.totalCharged)}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-brand-400">{t('credit.table.paid')}</p>
            <p className="text-lg font-bold text-emerald-700">{formatCurrency(totals.totalPaid)}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-brand-400">{t('credit.table.balance')}</p>
            <p className={`text-lg font-bold ${totals.totalBalance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{formatCurrency(totals.totalBalance)}</p>
          </div>
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!summaries && !error && <PageSpinner />}

      {summaries && summaries.length === 0 && (
        <Card>
          <EmptyState>{t('credit.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('credit.table.client')}</TableHead>
                  <TableHead>{t('credit.table.charged')}</TableHead>
                  <TableHead>{t('credit.table.paid')}</TableHead>
                  <TableHead className="text-right">{t('credit.table.balance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map(({ client, totalCharged, totalPaid, balance }) => (
                  <TableRow key={client.id} onClick={() => navigate(`/app/clients/${client.id}?tab=credito`)} className="cursor-pointer">
                    <TableCell className="text-xs font-medium text-brand-800">
                      <span className="flex items-center gap-2.5">
                        <InitialsAvatar name={client.full_name} size="sm" />
                        {client.full_name}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-brand-600">{formatCurrency(totalCharged)}</TableCell>
                    <TableCell className="text-xs text-emerald-700">{formatCurrency(totalPaid)}</TableCell>
                    <TableCell className={`text-right text-xs font-semibold ${balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                      {formatCurrency(balance)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}
    </div>
  )
}
