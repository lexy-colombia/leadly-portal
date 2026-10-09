import { dashboardAccess } from './dashboard/access'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  DollarSign,
  Receipt,
  Truck,
  Wallet,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import {
  listOverviewOrders,
  listOverviewDispatches,
  listOverviewConversations,
  listOverviewMessageTimings,
  getOverviewCredit,
} from '../../lib/api/dashboardOverview'
import { listTasks } from '../../lib/api/tasks'
import { listReturns } from '../../lib/api/returns'
import {
  getDefaultPipeline,
  listStages,
  listOpportunities,
} from '../../lib/api/opportunities'
import { getProductReport, getFinancialReport } from '../../lib/api/reports'
import { listProducts } from '../../lib/api/products'
import { getAgentActivitySummary } from '../../lib/api/agentActivity'
import {
  ORDER_STATUS_LABEL_KEY,
  DELIVERY_STATUS_LABEL_KEY,
} from '../../lib/api/orders'
import { formatDate } from '../../lib/dates'
import { Card, EmptyState } from '@/components/molecules'
import {
  SalesAreaChart,
  HorizontalBars,
  ChannelsChart,
} from './dashboard/Charts'
import {
  computeAvgResponseMinutes,
  dailySales,
  pendingOrders,
  periodWindow,
} from './dashboard/metrics'
import type { TranslationKey } from '../../i18n/translations'

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card
      padded={false}
      className="min-w-0 !rounded-2xl !border-brand-100/60 !shadow-none"
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <h2 className="font-sans text-sm font-extrabold text-brand-800">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-brand-400">
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="px-5 pb-5 pt-5">{children}</div>
    </Card>
  )
}
function LoadingState() {
  const { t } = useLanguage()
  return (
    <div role="status" className="flex min-h-36 items-center justify-center">
      <RefreshCw size={20} className="animate-spin text-accent-500" />
      <span className="sr-only">{t('common.status.loading')}</span>
    </div>
  )
}

function Resource({
  query,
  empty,
  children,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown }
  empty?: boolean
  children: ReactNode
}) {
  const { t } = useLanguage()
  if (query.isError)
    return (
      <div
        role="alert"
        className="rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700"
      >
        {t('dashboard.overview.loadError')}
        <button
          onClick={() => void query.refetch()}
          className="mt-2 block font-semibold underline"
        >
          {t('dashboard.overview.retry')}
        </button>
      </div>
    )
  if (query.isPending)
    return (
      <div className="flex min-h-36 items-center justify-center">
        <LoadingState />
      </div>
    )
  if (empty)
    return (
      <div className="flex min-h-36 items-center justify-center">
        <EmptyState>{t('dashboard.overview.noData')}</EmptyState>
      </div>
    )
  return children
}

export function Dashboard() {
  const { profile, enabledModules, permissions } = useAuth()
  const { t, language } = useLanguage()
  const [days, setDays] = useState(30)
  const [view, setView] = useState<'summary' | 'attention'>('summary')
  const [attentionTab, setAttentionTab] = useState<'orders' | 'credit'>(
    'orders',
  )
  const dateKey = new Date().toDateString()
  const window = useMemo(
    () => periodWindow(days, new Date(dateKey)),
    [days, dateKey],
  )
  const tenantId = profile?.tenant_id ?? ''
  const scope = [tenantId, profile?.id]
  const access = dashboardAccess(
    tenantId,
    profile?.role,
    enabledModules,
    permissions,
  )
  const {
    sales,
    dispatches,
    credit,
    reports,
    pipeline,
    tasks,
    conversations,
    returns,
  } = access
  const activeView = access.attention ? view : 'summary'
  const ordersQuery = useQuery({
    queryKey: [
      'dashboard',
      'orders',
      ...scope,
      window.previousStart.toISOString(),
    ],
    queryFn: () =>
      listOverviewOrders(tenantId, window.previousStart.toISOString()),
    enabled: sales && activeView === 'summary',
    staleTime: 60_000,
  })
  const dispatchQuery = useQuery({
    queryKey: ['dashboard', 'dispatches', ...scope, window.start.toISOString()],
    queryFn: () => listOverviewDispatches(tenantId, window.start.toISOString()),
    enabled: dispatches && activeView === 'summary',
    staleTime: 60_000,
  })
  const creditQuery = useQuery({
    queryKey: ['dashboard', 'credit', ...scope],
    queryFn: () => getOverviewCredit(tenantId),
    enabled: credit && activeView === 'summary',
    staleTime: 60_000,
  })
  const tasksQuery = useQuery({
    queryKey: ['dashboard', 'tasks', ...scope],
    queryFn: () => listTasks(tenantId),
    enabled: tasks && activeView === 'attention',
    staleTime: 60_000,
  })
  const returnsQuery = useQuery({
    queryKey: ['dashboard', 'returns', ...scope],
    queryFn: () => listReturns(tenantId),
    enabled: returns && sales && activeView === 'summary',
    staleTime: 60_000,
  })
  const productReport = useQuery({
    queryKey: [
      'dashboard',
      'product-report',
      ...scope,
      window.start.toISOString(),
      window.end.toISOString(),
    ],
    queryFn: () =>
      getProductReport(window.start.toISOString(), window.end.toISOString(), {
        limit: 5,
      }),
    enabled: reports && activeView === 'summary',
    staleTime: 60_000,
  })
  const financialReport = useQuery({
    queryKey: [
      'dashboard',
      'financial-report',
      ...scope,
      window.start.toISOString(),
      window.end.toISOString(),
    ],
    queryFn: () =>
      getFinancialReport(window.start.toISOString(), window.end.toISOString()),
    enabled: reports && activeView === 'summary',
    staleTime: 60_000,
  })
  const pipelineQuery = useQuery({
    queryKey: ['dashboard', 'pipeline', ...scope],
    queryFn: async () => {
      const p = await getDefaultPipeline(tenantId)
      if (!p) return { stages: [], opportunities: [] }
      const [stages, opportunities] = await Promise.all([
        listStages(p.id),
        listOpportunities(tenantId, p.id),
      ])
      return { stages, opportunities }
    },
    enabled: pipeline && activeView === 'attention',
    staleTime: 60_000,
  })
  const stockQuery = useQuery({
    queryKey: ['dashboard', 'low-stock', ...scope],
    queryFn: () =>
      listProducts(tenantId, { page: 1, pageSize: 5, lowStockOnly: true }),
    enabled: access.stock && activeView === 'summary',
    staleTime: 60_000,
  })
  const teamQuery = useQuery({
    queryKey: ['dashboard', 'team', ...scope],
    queryFn: () => getAgentActivitySummary(tenantId),
    enabled: access.team && activeView === 'attention',
    staleTime: 60_000,
  })
  const conversationQuery = useQuery({
    queryKey: [
      'dashboard',
      'conversations',
      ...scope,
      window.start.toISOString(),
      window.end.toISOString(),
    ],
    queryFn: () =>
      listOverviewConversations(
        tenantId,
        window.start.toISOString(),
        window.end.toISOString(),
      ),
    enabled: conversations && activeView === 'attention',
    staleTime: 60_000,
  })
  const timingsQuery = useQuery({
    queryKey: [
      'dashboard',
      'message-timings',
      ...scope,
      window.start.toISOString(),
      conversationQuery.data?.map((c) => c.id).join(','),
    ],
    queryFn: () =>
      listOverviewMessageTimings(
        tenantId,
        (conversationQuery.data ?? []).map((c) => c.id),
        window.start,
        window.end,
      ),
    enabled:
      conversations && activeView === 'attention' && !!conversationQuery.data?.length,
    staleTime: 60_000,
  })
  const queries = [
    ordersQuery,
    dispatchQuery,
    creditQuery,
    tasksQuery,
    returnsQuery,
    productReport,
    financialReport,
    pipelineQuery,
    stockQuery,
    teamQuery,
    conversationQuery,
    timingsQuery,
  ]
  const money = (value: number) =>
    new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    }).format(value)
  const compact = (value: number) =>
    value >= 1_000_000
      ? `${money(value / 1_000_000)}M`
      : value >= 1000
        ? `${money(value / 1000)}K`
        : money(value)
  const series = useMemo(
    () => dailySales(ordersQuery.data ?? [], window.start, window.end),
    [ordersQuery.data, window.start, window.end],
  )
  const previous = useMemo(
    () =>
      dailySales(ordersQuery.data ?? [], window.previousStart, window.start),
    [ordersQuery.data, window.previousStart, window.start],
  )
  const salesTotal = series.reduce((sum, p) => sum + p.value, 0),
    previousTotal = previous.reduce((sum, p) => sum + p.value, 0)
  const delta =
    previousTotal > 0
      ? ((salesTotal - previousTotal) / previousTotal) * 100
      : null
  const pending = pendingOrders(ordersQuery.data ?? [])
  const balance = (creditQuery.data ?? []).reduce(
    (sum, c) => sum + c.balance,
    0,
  )
  const pipelineRows = (pipelineQuery.data?.stages ?? []).map((stage) => ({
    label: stage.name,
    value: (pipelineQuery.data?.opportunities ?? []).filter(
      (o) => o.stage_id === stage.id,
    ).length,
  }))
  const pipelineValue = (pipelineQuery.data?.opportunities ?? []).reduce(
    (sum, o) => sum + o.value,
    0,
  )
  const channelLabels: Record<string, TranslationKey> = {
    pos: 'dashboard.overview.channelPos',
    whatsapp: 'dashboard.overview.channelWhatsapp',
    storefront: 'dashboard.overview.channelStorefront',
    portal: 'dashboard.overview.channelPortal',
    sin_canal: 'dashboard.overview.channelNone',
  }
  const channels = Object.entries(financialReport.data?.by_channel ?? {})
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({
      label: channelLabels[key] ? t(channelLabels[key]) : key,
      value,
    }))
  const activity = [
    ...(ordersQuery.data ?? [])
      .filter((o) => o.status !== 'cancelada')
      .map((order) => ({
        kind: 'order' as const,
        order,
        date: order.created_at,
      })),
    ...(returnsQuery.data ?? []).map((ret) => ({
      kind: 'return' as const,
      ret,
      date: ret.created_at,
    })),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5)
  const taskRows = (tasksQuery.data ?? [])
    .filter(
      (task) => task.status === 'pendiente' || task.status === 'en_proceso',
    )
    .sort(
      (a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime(),
    )
    .slice(0, 4)
  const dateLabel = (date: Date) =>
    date.toLocaleDateString(language === 'en' ? 'en-US' : 'es-CO', {
      day: 'numeric',
      month: 'short',
    })
  const link = (to: string, label: TranslationKey) => (
    <Link
      to={to}
      className="shrink-0 text-[11px] font-semibold text-accent-600 hover:underline"
    >
      {t(label)}
    </Link>
  )
  const tabs = [
    ...(sales
      ? [
          {
            key: 'orders' as const,
            label: 'dashboard.overview.ordersTab' as const,
          },
        ]
      : []),
    ...(credit
      ? [
          {
            key: 'credit' as const,
            label: 'dashboard.overview.creditTab' as const,
          },
        ]
      : []),
  ]
  const activeTab = tabs.some((tab) => tab.key === attentionTab)
    ? attentionTab
    : tabs[0]?.key
  const kpis = [
    ...(sales
      ? [
          {
            icon: DollarSign,
            title: t('dashboard.overview.sales'),
            value:
              ordersQuery.isError || !ordersQuery.data
                ? '—'
                : money(salesTotal),
            note: !ordersQuery.data
              ? ''
              : delta === null
                ? t('dashboard.overview.noPrevious')
                : `${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}% · ${t('dashboard.overview.previous')}`,
          },
          {
            icon: Receipt,
            title: t('dashboard.overview.pending'),
            value:
              ordersQuery.isError || !ordersQuery.data
                ? '—'
                : String(pending.length),
            note: t('dashboard.overview.current'),
          },
          ...(dispatches
            ? [
                {
                  icon: Truck,
                  title: t('dashboard.overview.periodDispatches'),
                  value:
                    dispatchQuery.isError || !dispatchQuery.data
                      ? '—'
                      : String(
                          dispatchQuery.data.filter(
                            (d) => new Date(d.created_at) < window.end,
                          ).length,
                        ),
                  note: t('dashboard.overview.periodDispatchHint'),
                },
              ]
            : []),
        ]
      : []),
    ...(credit
      ? [
          {
            icon: Wallet,
            title: t('dashboard.kpi.receivable.title'),
            value:
              creditQuery.isError || !creditQuery.data ? '—' : money(balance),
            note: t('dashboard.overview.current'),
          },
        ]
      : []),
  ]
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-sans text-2xl font-extrabold tracking-tight text-brand-800">
            {t('dashboard.overview.greeting', {
              name: profile?.full_name?.split(' ')[0] ?? '—',
            })}
          </h1>
          <p className="mt-1.5 text-xs text-brand-400">
            {t('dashboard.overview.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('dashboard.overview.period')}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-brand-100 bg-white px-3 py-2.5 text-xs text-brand-600"
          >
            {[7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {t(`dashboard.conversations.range.${d}` as TranslationKey)}
              </option>
            ))}
          </select>
          <button
            aria-label={t('dashboard.overview.refresh')}
            onClick={() =>
              queries
                .filter((q) => q.isEnabled)
                .forEach((q) => void q.refetch())
            }
            className="rounded-lg border border-brand-100 bg-white p-2.5 text-brand-400"
          >
            <RefreshCw
              size={15}
              className={
                queries.some((q) => q.isFetching) ? 'animate-spin' : ''
              }
            />
          </button>
          {access.newSale && activeView === 'summary' && (
            <Link
              to="/app/pos"
              className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-accent-700"
            >
              <Plus size={15} />
              {t('dashboard.overview.newSale')}
            </Link>
          )}
        </div>
      </header>
      {access.attention && (
        <div
          className="flex w-fit gap-1 rounded-lg border border-brand-100 bg-white p-1"
          role="tablist"
          aria-label={t('analytics.dashboard.title')}
        >
          {(['summary', 'attention'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={view === tab}
              onClick={() => setView(tab)}
              className={`rounded-md px-4 py-2 text-xs font-semibold ${view === tab ? 'bg-accent-50 text-accent-700' : 'text-brand-400 hover:bg-brand-50'}`}
            >
              {t(`dashboard.overview.${tab}`)}
            </button>
          ))}
        </div>
      )}
      {queries.some((q) => q.isEnabled && q.isError) && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800"
        >
          {t('dashboard.overview.partial')}
        </p>
      )}
      {activeView === 'summary' || !access.attention ? (
        <>
          {kpis.length > 0 && (
            <section className="grid grid-cols-2 gap-4 min-[1150px]:grid-cols-4">
              {kpis.map((kpi) => (
                <Card
                  key={kpi.title}
                  className="min-w-0 !rounded-2xl !border-brand-100/60 !p-4 !shadow-none"
                >
                  <div className="flex items-center gap-2">
                    <span className="hidden h-8 w-8 sm:flex shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-600">
                      <kpi.icon size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11px] text-brand-400">{kpi.title}</p>
                      <p className="mt-1 break-words font-sans text-lg font-extrabold tracking-tight tabular-nums text-brand-800 sm:text-xl">
                        {kpi.value}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 text-[10px] leading-relaxed text-brand-400">
                    {kpi.note}
                  </p>
                </Card>
              ))}
            </section>
          )}
          {(sales || reports) && (
            <section className="grid items-stretch gap-5 md:grid-cols-2 lg:grid-cols-3">
              {reports && (
                <Panel
                  title={t('dashboard.overview.products')}
                  subtitle={t('dashboard.overview.units')}
                  action={link(
                    '/app/reports',
                    'dashboard.overview.viewReports',
                  )}
                >
                  <Resource
                    query={productReport}
                    empty={!productReport.data?.top_by_quantity.length}
                  >
                    <HorizontalBars
                      rows={(productReport.data?.top_by_quantity ?? [])
                        .slice(0, 5)
                        .map((p) => ({
                          label: p.product_name,
                          value: p.quantity,
                        }))}
                      format={(value) =>
                        t('dashboard.overview.unitCount', { count: value })
                      }
                    />
                  </Resource>
                </Panel>
              )}
              {sales && (
                <Panel
                  title={t('dashboard.overview.salesTrend')}
                  subtitle={t('dashboard.overview.salesHint')}
                >
                  <Resource query={ordersQuery} empty={salesTotal === 0}>
                    <SalesAreaChart
                      points={series.map((p) => ({
                        label: dateLabel(p.date),
                        value: p.value,
                      }))}
                      format={compact}
                      detailFormat={money}
                      label={t('dashboard.overview.salesTrend')}
                    />
                  </Resource>
                </Panel>
              )}
              {reports && (
                <Panel
                  title={t('dashboard.overview.channels')}
                  subtitle={t('dashboard.overview.channelHint')}
                  action={link(
                    '/app/reports',
                    'dashboard.overview.viewReports',
                  )}
                >
                  <Resource
                    query={financialReport}
                    empty={channels.length === 0}
                  >
                    <ChannelsChart rows={channels} format={money} />
                  </Resource>
                </Panel>
              )}
            </section>
          )}
          {(sales || tabs.length > 0 || access.stock) && (
            <section className="grid items-stretch gap-5 md:grid-cols-2 lg:grid-cols-3">
              {sales && (
                <Panel
                  title={t('dashboard.overview.recent')}
                  action={link('/app/sales', 'dashboard.overview.viewAll')}
                >
                  <Resource query={ordersQuery} empty={activity.length === 0}>
                    <ul className="divide-y divide-brand-50">
                      {activity.map((item) =>
                        item.kind === 'order' ? (
                          <li
                            key={item.order.id}
                            className="flex items-center gap-3 py-3"
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-[10px] font-semibold text-accent-600">
                              {item.order.contact?.full_name
                                ?.slice(0, 2)
                                .toUpperCase() ?? '—'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <Link
                                to={`/app/sales/${item.order.id}`}
                                className="text-xs font-semibold text-brand-800 hover:text-accent-600"
                              >
                                {t(
                                  item.order.status === 'cotizacion'
                                    ? 'dashboard.overview.quote'
                                    : 'dashboard.overview.order',
                                  { number: item.order.number },
                                )}
                              </Link>
                              <p className="mt-1 truncate text-[10px] text-brand-400">
                                {item.order.contact?.full_name ??
                                  t('dashboard.overview.unknownClient')}
                              </p>
                            </div>
                            <div className="text-right">
                              <span className="rounded-full bg-brand-50 px-2 py-1 text-[9px] text-brand-500">
                                {t(
                                  item.order.status === 'cotizacion'
                                    ? ORDER_STATUS_LABEL_KEY.cotizacion
                                    : DELIVERY_STATUS_LABEL_KEY[
                                        item.order.delivery_status
                                      ],
                                )}
                              </span>
                              <p className="mt-2 text-[11px] font-medium tabular-nums">
                                {money(item.order.total)}
                              </p>
                            </div>
                          </li>
                        ) : (
                          <li key={item.ret.id} className="py-3">
                            <Link
                              to="/app/returns"
                              className="text-xs font-semibold text-brand-800"
                            >
                              {t('dashboard.recentActivity.return', {
                                number: item.ret.sales_order?.number ?? '—',
                              })}
                            </Link>
                            <p className="mt-1 text-[10px] text-brand-400">
                              {item.ret.status?.name ?? '—'} ·{' '}
                              {formatDate(item.ret.created_at)}
                            </p>
                          </li>
                        ),
                      )}
                    </ul>
                  </Resource>
                </Panel>
              )}
              {tabs.length > 0 && (
                <Panel
                  title={t('dashboard.overview.needsAttention')}
                  subtitle={t('dashboard.overview.current')}
                >
                  <div
                    className="mb-4 flex gap-1"
                    role="tablist"
                    aria-label={t('dashboard.overview.needsAttention')}
                  >
                    {tabs.map((tab) => (
                      <button
                        key={tab.key}
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        onClick={() => setAttentionTab(tab.key)}
                        className={`rounded-md px-3 py-2 text-[11px] font-medium ${activeTab === tab.key ? 'bg-accent-50 text-accent-700' : 'text-brand-400'}`}
                      >
                        {t(tab.label)}
                      </button>
                    ))}
                  </div>
                  {activeTab === 'orders' && (
                    <Resource query={ordersQuery} empty={pending.length === 0}>
                      <ul className="space-y-3">
                        {Object.entries(
                          pending.reduce<Record<string, number>>(
                            (counts, order) => {
                              counts[order.delivery_status] =
                                (counts[order.delivery_status] ?? 0) + 1
                              return counts
                            },
                            {},
                          ),
                        ).map(([status, count]) => (
                          <li key={status}>
                            <Link
                              to="/app/sales"
                              className="flex items-center justify-between rounded-lg border border-brand-100/60 p-3 text-xs hover:border-accent-300"
                            >
                              <span>
                                {t(
                                  DELIVERY_STATUS_LABEL_KEY[
                                    status as keyof typeof DELIVERY_STATUS_LABEL_KEY
                                  ],
                                )}
                              </span>
                              <strong>{count}</strong>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </Resource>
                  )}
                  {activeTab === 'credit' && (
                    <Resource
                      query={creditQuery}
                      empty={!creditQuery.data?.some((c) => c.balance > 0)}
                    >
                      <ul className="space-y-3">
                        {(creditQuery.data ?? [])
                          .filter((c) => c.balance > 0)
                          .sort((a, b) => b.balance - a.balance)
                          .slice(0, 4)
                          .map((c) => (
                            <li key={c.client.id}>
                              <Link
                                to="/app/credit"
                                className="flex items-center justify-between gap-3 rounded-lg border border-brand-100/60 p-3 text-xs hover:border-accent-300"
                              >
                                <span className="min-w-0 truncate">
                                  {c.client.full_name}
                                </span>
                                <strong className="shrink-0 tabular-nums">
                                  {money(c.balance)}
                                </strong>
                              </Link>
                            </li>
                          ))}
                      </ul>
                    </Resource>
                  )}
                </Panel>
              )}
              {access.stock && (
                <Panel
                  title={t('dashboard.overview.inventory')}
                  subtitle={
                    stockQuery.data
                      ? t('dashboard.overview.lowStock', {
                          count: stockQuery.data.count,
                        })
                      : undefined
                  }
                  action={link(
                    '/app/products',
                    'dashboard.overview.viewInventory',
                  )}
                >
                  <Resource
                    query={stockQuery}
                    empty={!stockQuery.data?.data.length}
                  >
                    <ul className="space-y-3">
                      {(stockQuery.data?.data ?? []).map((p) => (
                        <li key={p.id}>
                          <Link
                            to={`/app/products/${p.id}`}
                            className="block rounded-lg border border-brand-100/60 p-3 hover:border-accent-300"
                          >
                            <p className="text-xs font-semibold">{p.name}</p>
                            <p className="mt-1 text-[10px] text-brand-400">
                              {t('dashboard.overview.stockThreshold', {
                                count: p.low_stock_threshold,
                              })}
                            </p>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Resource>
                </Panel>
              )}
            </section>
          )}
          {!sales && !reports && !credit && !access.stock && (
            <Card>
              <EmptyState>{t('dashboard.overview.noModules')}</EmptyState>
            </Card>
          )}
          <p className="text-[11px] leading-relaxed text-brand-400">
            {t('dashboard.overview.info')}
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {conversations && (
              <>
                <Panel
                  title={t('dashboard.overview.conversationActivity')}
                  subtitle={t('dashboard.overview.conversationHint')}
                  action={link(
                    '/app/conversations',
                    'dashboard.overview.viewAll',
                  )}
                >
                  <Resource
                    query={conversationQuery}
                    empty={!conversationQuery.data?.length}
                  >
                    <p className="mb-5 font-sans text-3xl font-extrabold">
                      {
                        (conversationQuery.data ?? []).filter(
                          (c) =>
                            c.last_message_at &&
                            new Date(c.last_message_at) >= window.start &&
                            new Date(c.last_message_at) < window.end,
                        ).length
                      }
                    </p>
                    <SalesAreaChart
                      points={series.map((point) => ({
                        label: dateLabel(point.date),
                        value: (conversationQuery.data ?? []).filter(
                          (c) =>
                            c.last_message_at &&
                            new Date(c.last_message_at).toDateString() ===
                              point.date.toDateString(),
                        ).length,
                      }))}
                      format={String}
                      label={t('dashboard.overview.conversationActivity')}
                    />
                  </Resource>
                </Panel>
                <Panel
                  title={t('dashboard.overview.response')}
                  subtitle={t('dashboard.overview.responseHint')}
                >
                  <Resource
                    query={conversationQuery}
                    empty={!conversationQuery.data?.length}
                  >
                    {timingsQuery.isError ? (
                      <Resource query={timingsQuery}>{null}</Resource>
                    ) : timingsQuery.isPending && timingsQuery.isEnabled ? (
                      <LoadingState />
                    ) : (
                      (() => {
                        const minutes = computeAvgResponseMinutes(
                          timingsQuery.data ?? [],
                          window.start,
                          window.end,
                        )
                        return (
                          <p className="font-sans text-3xl font-extrabold">
                            {minutes === null
                              ? '—'
                              : minutes < 1
                                ? t('dashboard.overview.lessMinute')
                                : minutes < 60
                                  ? t('dashboard.overview.minutes', {
                                      count: Math.round(minutes),
                                    })
                                  : t('dashboard.overview.hours', {
                                      count: (minutes / 60).toFixed(1),
                                    })}
                          </p>
                        )
                      })()
                    )}
                  </Resource>
                </Panel>
              </>
            )}
            {pipeline && (
              <Panel
                title={t('dashboard.overview.pipeline')}
                action={link(
                  '/app/opportunities',
                  'dashboard.overview.viewCrm',
                )}
              >
                <Resource
                  query={pipelineQuery}
                  empty={pipelineRows.length === 0}
                >
                  <HorizontalBars rows={pipelineRows} format={String} />
                  <div className="mt-5 flex justify-between gap-3 rounded-lg bg-brand-50 p-3 text-[11px]">
                    <span className="text-brand-400">
                      {t('dashboard.overview.pipelineValue')}
                    </span>
                    <strong className="tabular-nums">
                      {money(pipelineValue)}
                    </strong>
                  </div>
                </Resource>
              </Panel>
            )}
          </section>
          {(tasks || access.team) && <section className={`grid gap-5 ${tasks && access.team ? 'lg:grid-cols-[1fr_2fr]' : 'grid-cols-1'}`}>
            {tasks && (
              <Panel
                title={t('dashboard.overview.tasksTab')}
                subtitle={t('dashboard.overview.current')}
                action={link('/app/calendar', 'dashboard.overview.viewAll')}
              >
                <Resource query={tasksQuery} empty={taskRows.length === 0}>
                  <ul className="space-y-3">
                    {taskRows.map((task) => (
                      <li key={task.id}>
                        <Link
                          to="/app/calendar"
                          className="block rounded-lg border border-brand-100/60 p-3 hover:border-accent-300"
                        >
                          <p className="text-xs font-medium">{task.title}</p>
                          <p className="mt-1.5 text-[10px] text-brand-400">
                            {task.due_date && formatDate(task.due_date)}
                            {task.due_date &&
                              new Date(task.due_date) < new Date() && (
                                <span className="ml-2 text-red-600">
                                  {t('dashboard.overview.overdue')}
                                </span>
                              )}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Resource>
              </Panel>
            )}
          {access.team && (
            <Panel
              title={t('dashboard.overview.team')}
              subtitle={t('dashboard.overview.humanTeam')}
            >
              <Resource query={teamQuery} empty={!teamQuery.data?.length}>
                <ul className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                  {(teamQuery.data ?? []).map((agent) => {
                    const completed =
                      agent.tasks_completed_on_time + agent.tasks_completed_late
                    const rate = completed
                      ? Math.round(
                          (agent.tasks_completed_on_time / completed) * 100,
                        )
                      : null
                    return (
                      <li
                        key={agent.agent_id}
                        className="rounded-lg border border-brand-100/60 p-4"
                      >
                        <strong className="text-xs">{agent.agent_name}</strong>
                        <p className="mt-2 text-[10px] text-brand-400">
                          {t('dashboard.overview.teamTasks', {
                            pending: agent.tasks_pending,
                            overdue: agent.tasks_overdue,
                          })}
                        </p>
                        <p className="mt-1 text-[10px] text-brand-400">
                          {t('dashboard.agentActivity.appointmentsOverdue')}:{' '}
                          {agent.appointments_overdue}
                        </p>
                        <div className="mt-3 flex justify-between text-[10px]">
                          <span className="text-brand-400">
                            {t('dashboard.overview.teamRate')}
                          </span>
                          <span>{rate === null ? '—' : `${rate}%`}</span>
                        </div>
                        <div className="mt-2 h-1.5 rounded-full bg-brand-50">
                          <div
                            className="h-full rounded-full bg-accent-500"
                            style={{ width: `${rate ?? 0}%` }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </Resource>
            </Panel>
          )}
          </section>}
        </div>
      )}
    </div>
  )
}
