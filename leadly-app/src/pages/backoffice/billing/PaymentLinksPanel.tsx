import { useCallback, useEffect, useState } from 'react'
import {
  listPaymentLinks,
  type PaymentClient,
  type PaymentLink,
  type PaymentLinkStatus,
} from '../../../lib/api/paymentLinks'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { PlusIcon } from '@/components/atoms/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDateTime } from '../../../lib/dates'
import { CopyButton } from './CopyButton'
import { GeneratePaymentLinkDrawer } from './GeneratePaymentLinkDrawer'

const ALL = '__all__'
const STATUSES: PaymentLinkStatus[] = ['creating', 'pending', 'paid', 'voided', 'expired', 'cancelled', 'error']

const STATUS_BADGE_CLASS: Record<PaymentLinkStatus, string> = {
  creating: 'border-transparent bg-slate-100 text-slate-600',
  pending: 'border-transparent bg-amber-100 text-amber-700',
  paid: 'border-transparent bg-emerald-100 text-emerald-700',
  voided: 'border-transparent bg-orange-100 text-orange-700',
  expired: 'border-transparent bg-slate-100 text-slate-600',
  cancelled: 'border-transparent bg-slate-100 text-slate-600',
  error: 'border-transparent bg-red-100 text-red-700',
}

/** Montos en centavos -> COP para mostrar (solo presentación). */
function formatMoney(amountInCents: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountInCents / 100)
}

/** La lista usa paginación por cursor (`before` / `next_before` del
 * contrato): no hay total ni número de página real, solo Anterior/Siguiente
 * apoyados en una pila de cursores ya visitados. */
export function PaymentLinksPanel({ projects }: { projects: PaymentClient[] | null }) {
  const { t, language } = useLanguage()
  const [clientFilter, setClientFilter] = useState(ALL)
  const [statusFilter, setStatusFilter] = useState(ALL)
  // cursors[i] = valor de `before` para pedir la página i (null = primera).
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [items, setItems] = useState<PaymentLink[] | null>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  const before = cursors[pageIndex] ?? null

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    listPaymentLinks({
      clientId: clientFilter === ALL ? null : clientFilter,
      status: statusFilter === ALL ? null : (statusFilter as PaymentLinkStatus),
      before,
    })
      .then((page) => {
        if (cancelled) return
        setItems(page.items)
        setNextBefore(page.next_before)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('common.status.error'))
      })
    return () => {
      cancelled = true
    }
  }, [clientFilter, statusFilter, before, reloadTick, t])

  const resetPaging = useCallback(() => {
    setCursors([null])
    setPageIndex(0)
  }, [])

  function goNext() {
    if (!nextBefore) return
    setCursors((prev) => [...prev.slice(0, pageIndex + 1), nextBefore])
    setPageIndex((i) => i + 1)
  }

  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? t('paymentLinks.links.unknownProject')

  return (
    <>
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-bold text-brand-800">{t('paymentLinks.links.title')}</h3>
            <p className="text-xs text-brand-400">{t('paymentLinks.links.subtitle')}</p>
          </div>
          <Button size="sm" onClick={() => setGenerateOpen(true)}>
            <PlusIcon width={14} height={14} /> {t('paymentLinks.links.generate')}
          </Button>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <Select
            value={clientFilter}
            onValueChange={(v) => {
              setClientFilter(v)
              resetPaging()
            }}
          >
            <SelectTrigger size="sm" className="w-48" aria-label={t('paymentLinks.links.filters.project')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('paymentLinks.links.filters.allProjects')}</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v)
              resetPaging()
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={t('paymentLinks.links.filters.status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('paymentLinks.links.filters.allStatuses')}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`paymentLinks.linkStatus.${s}` as TranslationKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            <span>
              {t('paymentLinks.links.loadError')} {error}
            </span>
            <Button variant="outline" size="xs" onClick={() => setReloadTick((n) => n + 1)}>
              {t('common.actions.retry')}
            </Button>
          </div>
        )}
        {!items && !error && <PageSpinner />}
        {items && items.length === 0 && <EmptyState>{t('paymentLinks.links.empty')}</EmptyState>}
        {items && items.length > 0 && (
          <>
            <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('paymentLinks.links.table.project')}</TableHead>
                    <TableHead>{t('paymentLinks.links.table.reference')}</TableHead>
                    <TableHead>{t('paymentLinks.links.table.amount')}</TableHead>
                    <TableHead>{t('paymentLinks.links.table.status')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('paymentLinks.links.table.date')}</TableHead>
                    <TableHead className="text-right">{t('paymentLinks.links.table.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((link) => (
                    <TableRow key={link.id}>
                      <TableCell className="font-medium text-brand-800">{projectName(link.client_id)}</TableCell>
                      <TableCell className="max-w-[180px] truncate text-brand-600" title={link.external_reference}>
                        {link.external_reference}
                      </TableCell>
                      <TableCell>{formatMoney(link.amount_in_cents, link.currency)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_BADGE_CLASS[link.status] ?? STATUS_BADGE_CLASS.creating} title={link.status_detail ?? undefined}>
                          {t(`paymentLinks.linkStatus.${link.status}` as TranslationKey)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden text-brand-400 sm:table-cell">{formatDateTime(link.created_at, language)}</TableCell>
                      <TableCell className="text-right">
                        {link.checkout_url ? (
                          <CopyButton value={link.checkout_url} label={t('paymentLinks.copyUrl')} />
                        ) : (
                          <span className="text-xs text-brand-400">{t('paymentLinks.links.noCheckoutUrl')}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {(pageIndex > 0 || nextBefore) && (
          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="text-xs text-brand-400">{t('paymentLinks.links.page', { page: pageIndex + 1 })}</span>
            <Button variant="outline" size="xs" disabled={pageIndex === 0} onClick={() => setPageIndex((i) => Math.max(0, i - 1))}>
              {t('paymentLinks.links.prev')}
            </Button>
            <Button variant="outline" size="xs" disabled={!nextBefore} onClick={goNext}>
              {t('paymentLinks.links.next')}
            </Button>
          </div>
        )}
      </Card>

      <GeneratePaymentLinkDrawer
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        projects={(projects ?? []).filter((p) => p.status === 'active')}
        onCreated={() => {
          resetPaging()
          setReloadTick((n) => n + 1)
        }}
      />
    </>
  )
}
