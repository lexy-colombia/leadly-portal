import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import {
  getFinancialReport,
  getProductReport,
  type DailySeriesPoint,
  type FinancialReport,
  type ProductReport,
  type ProductSummaryRow,
} from '../../lib/api/reports'
import { formatDate } from '../../lib/dates'
import type { TranslationKey } from '../../i18n/translations'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, FilterField } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface ReportFilters {
  /** YYYY-MM-DD, ambos inclusive -- el mismo formato que ExpensesTab.tsx.
   * La conversión al contrato [from, to) de reports-summary pasa por
   * isoRangeFromDates, nunca se manda esta cadena directo a la API. */
  dateFrom: string
  dateTo: string
}

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayIso(): string {
  return toDateOnly(new Date())
}

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return toDateOnly(d)
}

/** Default: últimos 30 días (hoy incluido) -- rango razonable para aterrizar
 * en la pantalla, a criterio del implementer (ver plan, sección 2.4). */
function defaultReportFilters(): ReportFilters {
  return { dateFrom: daysAgoIso(29), dateTo: todayIso() }
}

/** Convierte el rango YYYY-MM-DD (ambos inclusive, hora local) elegido en la
 * UI al contrato EXACTO que exige reports-summary/index.ts: [fromIso,
 * toIso), con toIso como el instante EXCLUSIVO de cierre -- medianoche
 * local del día SIGUIENTE al último día elegido, nunca 23:59:59 del mismo
 * día (eso dejaría fuera cualquier venta después de esa hora exacta). */
function isoRangeFromDates(dateFrom: string, dateTo: string): { fromIso: string; toIso: string } {
  const from = new Date(`${dateFrom}T00:00:00`)
  const toExclusive = new Date(`${dateTo}T00:00:00`)
  toExclusive.setDate(toExclusive.getDate() + 1)
  return { fromIso: from.toISOString(), toIso: toExclusive.toISOString() }
}

/** Rango inmediatamente anterior, de igual duración -- mismo criterio
 * `offsetDays` que Dashboard.tsx usa para las deltas "vs período anterior"
 * (bucketByDay/valueByDay), generalizado a dos instantes arbitrarios en vez
 * de un número fijo de días. No se reutilizan esas dos funciones tal
 * cual: bucketByDay/valueByDay bucketizan un array de filas día por día en
 * el navegador para dibujar un sparkline propio, mientras que acá el
 * agregado del período ya viene armado del lado del servidor (una sola
 * llamada por rango) -- alcanza con desplazar los dos instantes de la
 * llamada, no hay nada que bucketizar localmente. */
function previousIsoRange(fromIso: string, toIso: string): { fromIso: string; toIso: string } {
  const fromMs = new Date(fromIso).getTime()
  const toMs = new Date(toIso).getTime()
  const duration = toMs - fromMs
  return { fromIso: new Date(fromMs - duration).toISOString(), toIso: fromIso }
}

function deltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Mismas etiquetas que Dashboard.tsx: verde/positivo salvo que `invert` lo
 * pida al revés. No se reutiliza el `Delta` de Dashboard.tsx porque esa
 * función no está exportada (es privada de ese archivo) -- se recrea acá
 * en vez de exportarla desde Dashboard, que no fue pedido por el brief. */
function DeltaBadge({ pct, invert = false }: { pct: number; invert?: boolean }) {
  const { t } = useLanguage()
  const isGood = invert ? pct <= 0 : pct >= 0
  return (
    <span className={`text-[11px] font-medium ${isGood ? 'text-green-600' : 'text-red-600'}`}>
      {pct >= 0 ? '↑' : '↓'}
      {Math.abs(pct)}% {t('dashboard.vsPreviousPeriod')}
    </span>
  )
}

function StatCard({ label, value, delta, hint }: { label: string; value: string; delta?: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-brand-100 bg-white px-3 py-2.5">
      <p className="truncate text-[11px] text-brand-400">{label}</p>
      <p className="truncate text-sm font-bold text-brand-800">{value}</p>
      <div className="mt-0.5 min-h-[15px]">{delta}</div>
      {hint && <p className="mt-0.5 text-[10px] leading-snug text-brand-300">{hint}</p>}
    </div>
  )
}

const METHOD_LABEL_KEY: Record<string, TranslationKey> = {
  efectivo: 'reports.method.efectivo',
  transferencia: 'reports.method.transferencia',
  tarjeta: 'reports.method.tarjeta',
  credito: 'reports.method.credito',
  saldo_favor: 'reports.method.saldoFavor',
  wompi: 'reports.method.wompi',
}
const CHANNEL_LABEL_KEY: Record<string, TranslationKey> = {
  pos: 'reports.channel.pos',
  portal: 'reports.channel.portal',
  whatsapp: 'reports.channel.whatsapp',
  storefront: 'reports.channel.storefront',
  sin_canal: 'reports.channel.sinCanal',
}

/** Ordena un `Record<string, number>` de mayor a menor -- Object.entries no
 * garantiza ningún orden útil para un desglose visual. */
function sortedEntries(record: Record<string, number>): [string, number][] {
  return Object.entries(record).sort((a, b) => b[1] - a[1])
}

interface MoneyBreakdownItem {
  key: string
  label: string
  value: number
}

/** Lista de barras horizontales proporcionales al máximo del propio grupo --
 * usada para by_method/by_channel/expenses_by_category, todas
 * `Record<string, number>` en el contrato de reports-summary. */
function MoneyBreakdownList({ items, currency, emptyLabel }: { items: MoneyBreakdownItem[]; currency: string; emptyLabel: string }) {
  if (items.length === 0) return <EmptyState>{emptyLabel}</EmptyState>
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.key} className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-brand-600">{item.label}</span>
            <span className="shrink-0 font-semibold text-brand-800">{formatCurrency(item.value, currency)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-brand-100">
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${Math.max(3, (item.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

interface RankingItem {
  key: string
  label: string
  quantity: number
  revenue: number
}

/** Mismo criterio visual que MoneyBreakdownList, pero para by_category/
 * by_brand (product summary), que traen {quantity, revenue} por clave en
 * vez de un solo número -- ordenados por revenue, con quantity como dato
 * secundario. */
function RankingList({ items, currency, emptyLabel }: { items: RankingItem[]; currency: string; emptyLabel: string }) {
  if (items.length === 0) return <EmptyState>{emptyLabel}</EmptyState>
  const sorted = items.slice().sort((a, b) => b.revenue - a.revenue)
  const max = Math.max(1, ...sorted.map((i) => i.revenue))
  return (
    <ul className="space-y-2">
      {sorted.map((item) => (
        <li key={item.key} className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-brand-600">{item.label}</span>
            <span className="shrink-0 text-right">
              <span className="font-semibold text-brand-800">{formatCurrency(item.revenue, currency)}</span>
              <span className="ml-1.5 text-brand-400">· {item.quantity}</span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-brand-100">
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${Math.max(3, (item.revenue / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Ranking de productos (top_by_quantity/top_by_revenue) -- `product_id`
 * puede ser null (línea migrada de Fudo o de un producto borrado), en cuyo
 * caso igual se muestra `product_name` tal cual devuelve el servidor, sin
 * descartar la fila ni inventar un placeholder (ver contrato del plan). */
function ProductRankList({ rows, currency, emphasize }: { rows: ProductSummaryRow[]; currency: string; emphasize: 'quantity' | 'revenue' }) {
  return (
    <ol className="space-y-1.5">
      {rows.map((row, i) => (
        <li key={row.product_id ?? `noid-${i}-${row.product_name}`} className="flex items-center gap-2.5 rounded-lg border border-brand-100 px-2.5 py-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-500">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-brand-800">{row.product_name}</span>
          <span className="shrink-0 text-xs font-bold text-brand-800">{emphasize === 'quantity' ? row.quantity : formatCurrency(row.revenue, currency)}</span>
        </li>
      ))}
    </ol>
  )
}

/** Barras a mano, mismo estilo visual que ConversationsChart de
 * Dashboard.tsx (hover con tooltip, altura relativa al máximo del propio
 * rango) -- no se reutiliza ese componente porque no está exportado (es
 * privado de Dashboard.tsx) y trabaja sobre `DayBucket`/`count`, no sobre
 * `DailySeriesPoint`/revenue-o-quantity. `daily_series` ya viene
 * zero-filled por día desde el servidor (ver get_reports_product_summary),
 * así que acá no hace falta ningún bucketing local. */
function DailyBarChart({ points, metric, currency }: { points: DailySeriesPoint[]; metric: 'revenue' | 'quantity'; currency: string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const values = points.map((p) => p[metric])
  const max = Math.max(1, ...values)
  const labelEvery = Math.max(1, Math.ceil(points.length / 7))

  return (
    <div>
      <div className="flex h-28 items-stretch gap-1">
        {points.map((p, i) => (
          <div
            key={p.date}
            className="relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHoverIndex(i)}
            onMouseLeave={() => setHoverIndex((h) => (h === i ? null : h))}
          >
            {hoverIndex === i && (
              <div className="absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-brand-800 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
                {metric === 'revenue' ? formatCurrency(p.revenue, currency) : p.quantity} · {formatDate(p.date)}
              </div>
            )}
            <div
              className={`w-full rounded-t transition-colors ${hoverIndex === i ? 'bg-accent-600' : 'bg-accent-500'}`}
              style={{ height: `${Math.max(3, (values[i] / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1">
        {points.map((p, i) => (
          <span key={p.date} className="flex-1 truncate text-center text-[9px] text-brand-300">
            {i % labelEvery === 0 ? formatDate(p.date) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Reports() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const tenantId = profile?.tenant_id ?? null

  const [draft, setDraft] = useState<ReportFilters>(() => defaultReportFilters())
  const [filters, setFilters] = useState<ReportFilters>(() => defaultReportFilters())
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(filters)
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(defaultReportFilters())
  const rangeInvalid = draft.dateFrom > draft.dateTo

  const [financial, setFinancial] = useState<FinancialReport | null>(null)
  const [financialPrevious, setFinancialPrevious] = useState<FinancialReport | null>(null)
  const [products, setProducts] = useState<ProductReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [productMetric, setProductMetric] = useState<'revenue' | 'quantity'>('revenue')

  useEffect(() => {
    if (!tenantId) return
    if (filters.dateFrom > filters.dateTo) return
    let cancelled = false
    setLoading(true)
    setError(null)

    const { fromIso, toIso } = isoRangeFromDates(filters.dateFrom, filters.dateTo)
    const { fromIso: prevFromIso, toIso: prevToIso } = previousIsoRange(fromIso, toIso)

    Promise.all([getFinancialReport(fromIso, toIso), getFinancialReport(prevFromIso, prevToIso), getProductReport(fromIso, toIso)])
      .then(([current, previous, productData]) => {
        if (cancelled) return
        setFinancial(current)
        setFinancialPrevious(previous)
        setProducts(productData)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('reports.errors.loadFinancial'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [tenantId, filters, t])

  const currency = financial?.currency ?? 'COP'

  const incomeDeltaPct = useMemo(() => (financial && financialPrevious ? deltaPct(financial.income_total, financialPrevious.income_total) : null), [financial, financialPrevious])
  const netBalanceDeltaPct = useMemo(
    () => (financial && financialPrevious ? deltaPct(financial.net_balance, financialPrevious.net_balance) : null),
    [financial, financialPrevious],
  )
  const avgTicket = financial && financial.income_count > 0 ? financial.income_total / financial.income_count : null

  const methodItems: MoneyBreakdownItem[] = useMemo(
    () => (financial ? sortedEntries(financial.by_method).map(([key, value]) => ({ key, label: METHOD_LABEL_KEY[key] ? t(METHOD_LABEL_KEY[key]) : key, value })) : []),
    [financial, t],
  )
  const channelItems: MoneyBreakdownItem[] = useMemo(
    () => (financial ? sortedEntries(financial.by_channel).map(([key, value]) => ({ key, label: CHANNEL_LABEL_KEY[key] ? t(CHANNEL_LABEL_KEY[key]) : key, value })) : []),
    [financial, t],
  )
  const expenseCategoryItems: MoneyBreakdownItem[] = useMemo(
    () =>
      financial
        ? sortedEntries(financial.expenses_by_category).map(([key, value]) => ({ key, label: key === 'sin_categoria' ? t('reports.sinCategoria') : key, value }))
        : [],
    [financial, t],
  )

  const categoryItems: RankingItem[] = useMemo(
    () =>
      products
        ? Object.entries(products.by_category).map(([key, stat]) => ({ key, label: key === 'sin_categoria' ? t('reports.sinCategoria') : key, ...stat }))
        : [],
    [products, t],
  )
  const brandItems: RankingItem[] = useMemo(
    () => (products ? Object.entries(products.by_brand).map(([key, stat]) => ({ key, label: key === 'sin_marca' ? t('reports.sinMarca') : key, ...stat })) : []),
    [products, t],
  )

  const hasExpenses = financial ? financial.expenses_paid_count > 0 || financial.expenses_pending_count > 0 : false

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-brand-100 bg-brand-50/40 p-3">
        <FilterField label={t('reports.filters.dateFrom')}>
          <Input
            type="date"
            value={draft.dateFrom}
            onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value }))}
            aria-label={t('reports.filters.dateFrom')}
            className="h-7 w-36 rounded-lg border-brand-300 text-xs"
          />
        </FilterField>
        <FilterField label={t('reports.filters.dateTo')}>
          <Input
            type="date"
            value={draft.dateTo}
            onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value }))}
            aria-label={t('reports.filters.dateTo')}
            className="h-7 w-36 rounded-lg border-brand-300 text-xs"
          />
        </FilterField>
        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          <Button type="button" size="sm" disabled={!filtersDirty || rangeInvalid} onClick={() => setFilters(draft)}>
            {t('reports.filters.apply')}
          </Button>
          {(filtersActive || filtersDirty) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                const cleared = defaultReportFilters()
                setDraft(cleared)
                setFilters(cleared)
              }}
            >
              {t('reports.filters.clear')}
            </Button>
          )}
        </div>
        {rangeInvalid && <p className="w-full text-[11px] text-red-600">{t('reports.filters.invalidRange')}</p>}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {loading && !financial && !products && <PageSpinner />}

      {financial && products && (
        <>
          {/* --- Balance financiero --- */}
          <Card className="!p-3.5">
            <h2 className="mb-3 text-xs font-semibold text-brand-800">{t('reports.financial.title')}</h2>

            {financial.income_count === 0 ? (
              <EmptyState>{t('reports.financial.empty')}</EmptyState>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    label={t('reports.financial.income.title')}
                    value={formatCurrency(financial.income_total, currency)}
                    delta={incomeDeltaPct !== null ? <DeltaBadge pct={incomeDeltaPct} /> : undefined}
                    hint={t('reports.financial.income.count', { count: financial.income_count })}
                  />
                  <StatCard label={t('reports.financial.avgTicket.title')} value={avgTicket !== null ? formatCurrency(avgTicket, currency) : '—'} />
                  <StatCard
                    label={t('reports.financial.netBalance.title')}
                    value={formatCurrency(financial.net_balance, currency)}
                    delta={netBalanceDeltaPct !== null ? <DeltaBadge pct={netBalanceDeltaPct} /> : undefined}
                    hint={t('reports.financial.netBalance.hint')}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <StatCard label={t('reports.financial.invoiced.title')} value={formatCurrency(financial.invoiced_total, currency)} hint={String(financial.invoiced_count)} />
                    <StatCard
                      label={t('reports.financial.notInvoiced.title')}
                      value={formatCurrency(financial.not_invoiced_total, currency)}
                      hint={String(financial.not_invoiced_count)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.financial.byMethod.title')}</h3>
                    <MoneyBreakdownList items={methodItems} currency={currency} emptyLabel={t('reports.financial.empty')} />
                  </div>
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.financial.byChannel.title')}</h3>
                    <MoneyBreakdownList items={channelItems} currency={currency} emptyLabel={t('reports.financial.empty')} />
                  </div>
                </div>

                {(financial.credit_notes_total > 0 || financial.returns_total > 0) && (
                  <div className="grid grid-cols-2 gap-2">
                    <StatCard label={t('reports.financial.deductions.creditNotes')} value={formatCurrency(financial.credit_notes_total, currency)} />
                    <StatCard label={t('reports.financial.deductions.returns')} value={formatCurrency(financial.returns_total, currency)} />
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 border-t border-brand-100 pt-3">
              <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.financial.expenses.title')}</h3>
              {!hasExpenses ? (
                <EmptyState>{t('reports.financial.noExpenses')}</EmptyState>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <StatCard
                      label={t('reports.financial.expenses.paid')}
                      value={formatCurrency(financial.expenses_paid_total, currency)}
                      hint={String(financial.expenses_paid_count)}
                    />
                    <StatCard
                      label={t('reports.financial.expenses.pending')}
                      value={formatCurrency(financial.expenses_pending_total, currency)}
                      hint={String(financial.expenses_pending_count)}
                    />
                  </div>
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h4 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.financial.expenses.byCategory.title')}</h4>
                    <MoneyBreakdownList items={expenseCategoryItems} currency={currency} emptyLabel={t('reports.financial.noExpenses')} />
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* --- Reportes de productos --- */}
          <Card className="!p-3.5">
            <h2 className="mb-3 text-xs font-semibold text-brand-800">{t('reports.products.title')}</h2>

            {financial.income_count === 0 ? (
              <EmptyState>{t('reports.products.empty')}</EmptyState>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.products.topByQuantity.title')}</h3>
                    {products.top_by_quantity.length === 0 ? (
                      <EmptyState>{t('reports.products.empty')}</EmptyState>
                    ) : (
                      <ProductRankList rows={products.top_by_quantity} currency={currency} emphasize="quantity" />
                    )}
                  </div>
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.products.topByRevenue.title')}</h3>
                    {products.top_by_revenue.length === 0 ? (
                      <EmptyState>{t('reports.products.empty')}</EmptyState>
                    ) : (
                      <ProductRankList rows={products.top_by_revenue} currency={currency} emphasize="revenue" />
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-brand-100 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-[11px] font-semibold text-brand-600">{t('reports.products.dailySeries.title')}</h3>
                    <Select value={productMetric} onValueChange={(v) => setProductMetric(v as 'revenue' | 'quantity')}>
                      <SelectTrigger className="!h-7 !w-auto !rounded-lg !text-xs">
                        <SelectValue>{t(`reports.products.dailySeries.metric.${productMetric}`)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="revenue" className="text-xs">
                          {t('reports.products.dailySeries.metric.revenue')}
                        </SelectItem>
                        <SelectItem value="quantity" className="text-xs">
                          {t('reports.products.dailySeries.metric.quantity')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <DailyBarChart points={products.daily_series} metric={productMetric} currency={currency} />
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.products.byCategory.title')}</h3>
                    <RankingList items={categoryItems} currency={currency} emptyLabel={t('reports.products.empty')} />
                  </div>
                  <div className="rounded-lg border border-brand-100 p-3">
                    <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.products.byBrand.title')}</h3>
                    <RankingList items={brandItems} currency={currency} emptyLabel={t('reports.products.empty')} />
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 border-t border-brand-100 pt-3">
              <h3 className="mb-2 text-[11px] font-semibold text-brand-600">{t('reports.products.staleProducts.title')}</h3>
              <p className="mb-2 text-[10px] text-brand-400">{t('reports.products.staleProducts.subtitle', { days: 30 })}</p>
              {products.stale_products.length === 0 ? (
                <EmptyState>{t('reports.products.staleProducts.empty')}</EmptyState>
              ) : (
                <ul className="space-y-1.5">
                  {products.stale_products.map((p) => (
                    <li key={p.product_id} className="flex items-center justify-between gap-2 rounded-lg border border-brand-100 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-brand-800">{p.product_name}</span>
                      <span className="shrink-0 text-[11px] text-brand-400">
                        {p.last_sale_at ? t('reports.products.staleProducts.lastSale', { date: formatDate(p.last_sale_at) }) : t('reports.products.staleProducts.neverSold')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3 border-t border-brand-100 pt-3">
              <h3 className="mb-1 text-[11px] font-semibold text-brand-600">{t('reports.products.grossMargin.title')}</h3>
              <p className="mb-2 text-[10px] leading-snug text-brand-400">{t('reports.products.grossMargin.notice')}</p>
              {products.gross_margin.length === 0 ? (
                <EmptyState>{t('reports.products.empty')}</EmptyState>
              ) : (
                <div className="overflow-hidden rounded-lg border border-brand-100">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('reports.products.table.product')}</TableHead>
                        <TableHead>{t('reports.products.table.revenue')}</TableHead>
                        <TableHead>{t('reports.products.table.cost')}</TableHead>
                        <TableHead>{t('reports.products.table.margin')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {products.gross_margin.map((row, i) => (
                        <TableRow key={row.product_id ?? `noid-${i}-${row.product_name}`}>
                          <TableCell className="text-xs font-medium text-brand-800">{row.product_name}</TableCell>
                          <TableCell className="text-xs text-brand-700">{formatCurrency(row.revenue, currency)}</TableCell>
                          <TableCell className="text-xs text-brand-700">
                            {row.estimated_cost === null ? <span className="text-brand-300">{t('reports.products.grossMargin.unknownCost')}</span> : formatCurrency(row.estimated_cost, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-brand-700">{row.estimated_margin === null ? '—' : formatCurrency(row.estimated_margin, currency)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
