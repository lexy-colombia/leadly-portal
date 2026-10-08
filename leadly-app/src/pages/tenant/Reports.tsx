import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import {
  getFinancialReport,
  getSoldProducts,
  getProductReport,
  type FinancialReport,
  type ProductReport,
  type ProductSummaryRow,
} from '../../lib/api/reports'
import { formatDate } from '../../lib/dates'
import type { TranslationKey } from '../../i18n/translations'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { TrendChart } from '@/components/analytics/TrendChart'
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
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value || 0)
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

function StatCard({ label, value, delta, hint, compact = false }: { label: string; value: string; delta?: React.ReactNode; hint?: string; compact?: boolean }) {
  return (
    <div className={`min-w-0 border border-brand-100 bg-white ${compact ? 'rounded-xl px-3 py-2.5' : 'rounded-2xl p-4'}`}>
      <p className="truncate text-[11px] text-brand-400">{label}</p>
      <p className={`font-bold tracking-tight tabular-nums text-brand-800 ${compact ? 'mt-1 text-xl leading-tight' : 'mt-2 text-2xl'}`}>{value}</p>
      {delta && <div className="mt-0.5 leading-tight">{delta}</div>}
      {hint && <p className={`mt-0.5 text-brand-400 ${compact ? 'text-[11px] leading-tight' : 'text-xs leading-relaxed'}`}>{hint}</p>}
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
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${Math.max(0, (item.value / max) * 100)}%` }} />
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
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${Math.max(0, (item.revenue / max) * 100)}%` }} />
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

export function Reports() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const tenantId = profile?.tenant_id ?? null

  const [draft, setDraft] = useState<ReportFilters>(() => defaultReportFilters())
  const [filters, setFilters] = useState<ReportFilters>(() => defaultReportFilters())
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(filters)
  const rangeInvalid = !draft.dateFrom || !draft.dateTo || draft.dateFrom > draft.dateTo

  const [preset, setPreset] = useState('30')
  const [refresh, setRefresh] = useState(0)
  const [soldProducts, setSoldProducts] = useState<ProductSummaryRow[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'revenue' | 'quantity' | 'name'>('revenue')
  const [page, setPage] = useState(1)

  function applyPreset(value: string) {
    setPreset(value)
    if (value === 'custom') return
    const dateFrom = value === 'month' ? `${todayIso().slice(0,7)}-01` : daysAgoIso(Number(value)-1)
    const range = { dateFrom, dateTo: todayIso() }
    setDraft(range)
    setFilters(range)
    setPage(1)
  }

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
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    const { fromIso, toIso } = isoRangeFromDates(filters.dateFrom, filters.dateTo)
    const { fromIso: prevFromIso, toIso: prevToIso } = previousIsoRange(fromIso, toIso)

    Promise.all([getFinancialReport(fromIso, toIso), getFinancialReport(prevFromIso, prevToIso), getProductReport(fromIso, toIso), getSoldProducts(tenantId, fromIso, toIso, controller.signal)])
      .then(([current, previous, productData, allProducts]) => {
        if (cancelled) return
        setFinancial(current)
        setFinancialPrevious(previous)
        setProducts({ ...productData, daily_series: allProducts.dailySeries })
        setSoldProducts(allProducts.rows)
        setPage(1)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : (language === 'en' ? 'Could not load reports.' : 'No se pudieron cargar los reportes.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [tenantId, filters, refresh, language])

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

  const soldRevenue = soldProducts.reduce((sum, p) => sum + p.revenue, 0)
  const filteredProducts = useMemo(() => soldProducts.filter((p) => p.product_name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b) => sort === 'name' ? a.product_name.localeCompare(b.product_name) : b[sort]-a[sort] || a.product_name.localeCompare(b.product_name)), [soldProducts,search,sort])
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length/20))
  const currentPage = Math.min(page,pageCount)
  const pageRows = filteredProducts.slice((currentPage-1)*20,currentPage*20)

  function exportProducts() {
    const cell = (value: string | number) => '"' + String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"','""') + '"'
    const header = [t('reports.products.table.product'),t('reports.products.table.quantity'),t('analytics.productSales'),currency]
    const csv = '\ufeff'+[header,...filteredProducts.map((p) => [p.product_name,p.quantity,p.revenue,currency])].map((row) => row.map(cell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}))
    const anchor = document.createElement('a')
    anchor.href=url
    anchor.download=`productos-${filters.dateFrom}-${filters.dateTo}.csv`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url),1000)
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label={t('analytics.period')}><Select value={preset} onValueChange={applyPreset}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{['7','30','90','month','custom'].map((v) => <SelectItem key={v} value={v}>{t(`analytics.period.${v}` as TranslationKey)}</SelectItem>)}</SelectContent></Select></FilterField>
          <FilterField label={t('reports.filters.dateFrom')}><Input type="date" value={draft.dateFrom} onChange={(e) => { setPreset('custom'); setDraft((d) => ({ ...d, dateFrom: e.target.value })) }} aria-label={t('reports.filters.dateFrom')} className="w-40" /></FilterField>
          <FilterField label={t('reports.filters.dateTo')}><Input type="date" value={draft.dateTo} onChange={(e) => { setPreset('custom'); setDraft((d) => ({ ...d, dateTo: e.target.value })) }} aria-label={t('reports.filters.dateTo')} className="w-40" /></FilterField>
          <Button type="button" disabled={!filtersDirty || rangeInvalid || loading} onClick={() => setFilters({ ...draft })}>{t('reports.filters.apply')}</Button>
          <Button type="button" variant="outline" disabled={loading} onClick={() => setRefresh((v) => v + 1)}>{t('analytics.refresh')}</Button>
        </div>
        {rangeInvalid && <p role="alert" className="mt-2 text-xs text-red-600">{t('reports.filters.invalidRange')}</p>}
        {filtersDirty && !rangeInvalid && <p className="mt-2 text-xs text-brand-400">{t('analytics.unapplied')}</p>}
      </Card>
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}<Button type="button" variant="outline" className="ml-3" onClick={() => setRefresh((v) => v + 1)}>{t('analytics.retry')}</Button></div>}
      {loading && <PageSpinner />}
      {!loading && !error && financial && products && (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard compact label={t('analytics.sales')} value={formatCurrency(financial.income_total, currency)} delta={incomeDeltaPct !== null ? <DeltaBadge pct={incomeDeltaPct} /> : undefined} hint={t('reports.financial.income.count', {count:financial.income_count})} />
            <StatCard compact label={t('analytics.paidExpenses')} value={formatCurrency(financial.expenses_paid_total, currency)} hint={t('analytics.paidExpenses.hint')} />
            <StatCard compact label={t('analytics.operatingBalance')} value={formatCurrency(financial.net_balance, currency)} delta={netBalanceDeltaPct !== null ? <DeltaBadge pct={netBalanceDeltaPct} /> : undefined} hint={t('analytics.balance.hint')} />
            <StatCard compact label={t('reports.financial.avgTicket.title')} value={avgTicket !== null ? formatCurrency(avgTicket, currency) : '—'} hint={t('analytics.ticket.hint')} />
          </div>
          <Tabs defaultValue="financial">
            <TabsList><TabsTrigger value="financial">{t('analytics.tab.financial')}</TabsTrigger><TabsTrigger value="products">{t('analytics.tab.products')}</TabsTrigger><TabsTrigger value="health">{t('analytics.tab.health')}</TabsTrigger></TabsList>
            <TabsContent value="financial" className="mt-3 flex flex-col gap-4">
              <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
                <Card><div className="mb-6"><h2 className="font-sans text-base font-bold text-brand-800">{t('reports.products.dailySeries.title')}</h2><p className="mt-1 text-xs text-brand-400">{t('analytics.series.hint')}</p></div><TrendChart points={products.daily_series.map((p) => ({label:formatDate(p.date),value:p.revenue}))} formatValue={(v) => formatCurrency(v,currency)} label={t('analytics.dataTable')} /></Card>
                <Card><h2 className="font-sans text-base font-bold text-brand-800">{t('analytics.balance.title')}</h2><p className="mt-1 text-xs text-brand-400">{t('analytics.balance.notice')}</p><dl className="mt-5 flex flex-col gap-4">{[
                  [t('analytics.sales'),financial.income_total], [t('reports.financial.deductions.creditNotes'),-financial.credit_notes_total], [t('reports.financial.deductions.returns'),-financial.returns_total], [t('analytics.paidExpenses'),-financial.expenses_paid_total],
                ].map(([label,value]) => <div key={label} className="flex items-center justify-between gap-3 text-xs"><dt className="text-brand-500">{label}</dt><dd className="font-semibold tabular-nums text-brand-800">{formatCurrency(Number(value),currency)}</dd></div>)}<div className="flex justify-between gap-3 border-t border-brand-100 pt-4"><dt className="text-sm font-semibold text-brand-700">{t('analytics.operatingBalance')}</dt><dd className="text-lg font-bold tabular-nums text-accent-600">{formatCurrency(financial.net_balance,currency)}</dd></div></dl></Card>
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card><h2 className="mb-5 text-sm font-bold text-brand-800">{t('reports.financial.byChannel.title')}</h2><MoneyBreakdownList items={channelItems} currency={currency} emptyLabel={t('reports.financial.empty')} /></Card>
                <Card><h2 className="mb-2 text-sm font-bold text-brand-800">{t('analytics.paymentMethods')}</h2><p className="mb-4 text-xs text-brand-400">{t('analytics.paymentMethods.hint')}</p><MoneyBreakdownList items={methodItems} currency={currency} emptyLabel={t('analytics.noPayments')} /></Card>
                <Card><h2 className="mb-2 text-sm font-bold text-brand-800">{t('reports.financial.expenses.byCategory.title')}</h2><p className="mb-4 text-xs text-brand-400">{t('analytics.expenseCategory.hint')}</p><MoneyBreakdownList items={expenseCategoryItems} currency={currency} emptyLabel={t('reports.financial.noExpenses')} /></Card>
              </div>
              <div className="grid gap-3 sm:grid-cols-3"><StatCard label={t('reports.financial.invoiced.title')} value={formatCurrency(financial.invoiced_total,currency)} hint={t('analytics.invoice.hint')} /><StatCard label={t('reports.financial.notInvoiced.title')} value={formatCurrency(financial.not_invoiced_total,currency)} /><StatCard label={t('reports.financial.expenses.pending')} value={formatCurrency(financial.expenses_pending_total,currency)} hint={t('analytics.pending.hint')} /></div>
            </TabsContent>
            <TabsContent value="products" className="mt-3 flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-3"><StatCard label={t('analytics.productsSold')} value={String(soldProducts.length)} /><StatCard label={t('reports.products.table.quantity')} value={String(soldProducts.reduce((sum,p) => sum+p.quantity,0))} /><StatCard label={t('analytics.productSales')} value={formatCurrency(soldProducts.reduce((sum,p) => sum+p.revenue,0),currency)} hint={t('analytics.productSales.hint')} /></div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card><h2 className="mb-5 text-sm font-bold text-brand-800">{t('reports.products.topByRevenue.title')}</h2><ProductRankList rows={soldProducts.slice(0,5)} currency={currency} emphasize="revenue" /></Card>
                <Card><div className="mb-5 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-bold text-brand-800">{t('reports.products.dailySeries.title')}</h2><Select value={productMetric} onValueChange={(v) => setProductMetric(v as 'revenue'|'quantity')}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="revenue">{t('analytics.sales')}</SelectItem><SelectItem value="quantity">{t('reports.products.table.quantity')}</SelectItem></SelectContent></Select></div><TrendChart points={products.daily_series.map((p) => ({label:formatDate(p.date),value:p[productMetric]}))} formatValue={(v) => productMetric==='revenue'?formatCurrency(v,currency):String(Math.round(v))} label={t('analytics.dataTable')} /></Card>
              </div>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-bold text-brand-800">{t('analytics.allProducts')}</h2><p className="mt-1 text-xs text-brand-400">{t('analytics.allProducts.hint')}</p></div><Button variant="outline" disabled={filteredProducts.length===0} onClick={exportProducts}>{t('analytics.export')}</Button></div>
                <div className="my-5 flex flex-wrap gap-3"><Input value={search} onChange={(e) => {setSearch(e.target.value);setPage(1)}} placeholder={t('analytics.searchProducts')} aria-label={t('analytics.searchProducts')} className="max-w-xs" /><Select value={sort} onValueChange={(v) => {setSort(v as typeof sort);setPage(1)}}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="revenue">{t('analytics.sort.revenue')}</SelectItem><SelectItem value="quantity">{t('analytics.sort.quantity')}</SelectItem><SelectItem value="name">{t('analytics.sort.name')}</SelectItem></SelectContent></Select></div>
                <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t('reports.products.table.product')}</TableHead><TableHead className="text-right">{t('reports.products.table.quantity')}</TableHead><TableHead className="text-right">{t('analytics.productSales')}</TableHead><TableHead className="text-right">{t('analytics.unitAverage')}</TableHead><TableHead className="text-right">{t('analytics.share')}</TableHead></TableRow></TableHeader><TableBody>{pageRows.map((p,i) => <TableRow key={p.product_id??`name-${i}-${p.product_name}`}><TableCell className="font-medium text-brand-800">{p.product_name}</TableCell><TableCell className="text-right tabular-nums">{p.quantity}</TableCell><TableCell className="text-right font-semibold tabular-nums">{formatCurrency(p.revenue,currency)}</TableCell><TableCell className="text-right tabular-nums">{p.quantity?formatCurrency(p.revenue/p.quantity,currency):'—'}</TableCell><TableCell className="text-right tabular-nums">{soldRevenue>0?`${((p.revenue/soldRevenue)*100).toFixed(1)}%`:'—'}</TableCell></TableRow>)}{pageRows.length===0&&<TableRow><TableCell colSpan={5}><EmptyState>{t('analytics.noResults')}</EmptyState></TableCell></TableRow>}</TableBody></Table></div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-brand-100 pt-4"><p className="text-xs text-brand-400">{t('analytics.pagination',{count:filteredProducts.length,page:currentPage,total:pageCount})}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={currentPage===1} onClick={() => setPage(currentPage-1)}>{t('analytics.previous')}</Button><Button variant="outline" size="sm" disabled={currentPage===pageCount} onClick={() => setPage(currentPage+1)}>{t('analytics.next')}</Button></div></div>
              </Card>
              <div className="grid gap-4 lg:grid-cols-2"><Card><h2 className="mb-5 text-sm font-bold text-brand-800">{t('reports.products.byCategory.title')}</h2><p className="mb-3 text-xs text-brand-400">{t('analytics.categories.hint')}</p><RankingList items={categoryItems} currency={currency} emptyLabel={t('reports.products.empty')} /></Card><Card><h2 className="mb-5 text-sm font-bold text-brand-800">{t('reports.products.byBrand.title')}</h2><RankingList items={brandItems} currency={currency} emptyLabel={t('reports.products.empty')} /></Card></div>
            </TabsContent>
            <TabsContent value="health" className="mt-3 flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2"><StatCard label={t('reports.financial.expenses.pending')} value={formatCurrency(financial.expenses_pending_total,currency)} hint={t('analytics.pending.hint')} /><StatCard label={t('reports.financial.notInvoiced.title')} value={formatCurrency(financial.not_invoiced_total,currency)} hint={t('analytics.notInvoiced.hint')} /></div>
              <Card><h2 className="text-base font-bold text-brand-800">{t('reports.products.staleProducts.title')}</h2><p className="mt-1 mb-4 text-xs text-brand-400">{t('analytics.stale.hint')}</p>{products.stale_products.length===0?<EmptyState>{t('reports.products.staleProducts.empty')}</EmptyState>:<ul className="divide-y divide-brand-100">{products.stale_products.map((p) => <li key={p.product_id} className="flex flex-wrap justify-between gap-2 py-3 text-xs"><span className="font-semibold text-brand-700">{p.product_name}</span><span className="text-brand-400">{p.last_sale_at?t('reports.products.staleProducts.lastSale',{date:formatDate(p.last_sale_at)}):t('reports.products.staleProducts.neverSold')}</span></li>)}</ul>}</Card>
              <Card><h2 className="text-base font-bold text-brand-800">{t('reports.products.grossMargin.title')}</h2><p className="mt-1 mb-4 text-xs leading-relaxed text-brand-400">{t('reports.products.grossMargin.notice')} {t('analytics.margin.hint')}</p><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t('reports.products.table.product')}</TableHead><TableHead>{t('reports.products.table.revenue')}</TableHead><TableHead>{t('reports.products.table.cost')}</TableHead><TableHead>{t('reports.products.table.margin')}</TableHead></TableRow></TableHeader><TableBody>{products.gross_margin.map((p,i) => <TableRow key={p.product_id??i}><TableCell>{p.product_name}</TableCell><TableCell>{formatCurrency(p.revenue,currency)}</TableCell><TableCell>{p.estimated_cost===null?t('reports.products.grossMargin.unknownCost'):formatCurrency(p.estimated_cost,currency)}</TableCell><TableCell>{p.estimated_margin===null?'—':formatCurrency(p.estimated_margin,currency)}</TableCell></TableRow>)}</TableBody></Table></div></Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
