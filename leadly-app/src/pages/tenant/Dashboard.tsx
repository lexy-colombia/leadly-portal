import { useEffect, useMemo, useState, type SVGProps } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { listTasks, TASK_PRIORITY_KEY, type TaskWithRelations } from '../../lib/api/tasks'
import { listConversations, listMessageTimingsForConversations, type ConversationWithLine, type MessageTiming } from '../../lib/api/conversations'
import {
  computePipelineMetrics,
  getDefaultPipeline,
  listOpportunities,
  listStageHistoryForOpportunities,
  listStages,
  type OpportunityWithRelations,
  type StageHistoryRow,
} from '../../lib/api/opportunities'
import {
  listOrders,
  ORDER_STATUS_BADGE_CLASS,
  ORDER_STATUS_LABEL_KEY,
  DELIVERY_STATUS_BADGE_CLASS,
  DELIVERY_STATUS_LABEL_KEY,
  type OrderWithRelations,
} from '../../lib/api/orders'
import { listReturns, type ReturnWithOrder } from '../../lib/api/returns'
import { listDispatchesForTenant } from '../../lib/api/dispatches'
import { listCreditClients, type ClientCreditSummary } from '../../lib/api/credit'
import type { PipelineStage, OpportunityPriority, Dispatch } from '../../types/domain'
import { getAgentActivitySummary, type AgentActivitySummary } from '../../lib/api/agentActivity'
import { formatDate } from '../../lib/dates'
import { Badge, PageSpinner, Select } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CalendarIcon, DollarIcon, InfoIcon, ReceiptIcon, RefreshIcon, TruckIcon, WalletIcon } from '@/components/atoms/icons'

const PRIORITY_TONE: Record<OpportunityPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }
type RangeDays = 7 | 14 | 30

function formatCompactCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

function formatFullCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

function formatTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(language === 'en' ? 'en-US' : 'es-CO', { hour: '2-digit', minute: '2-digit' })
}

function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`
  return `${(min / 60).toFixed(1).replace(/\.0$/, '')} h`
}

interface DayBucket {
  key: string
  label: string
  count: number
}

interface DayValueBucket {
  key: string
  label: string
  value: number
}

/** Buckets conversations by day of `last_message_at` into a fixed-length
 * window -- `offsetDays` shifts the whole window into the past so the same
 * function builds both the current period and the immediately-preceding one
 * (for the "vs período anterior" deltas), instead of two separate
 * implementations that could drift apart. */
function bucketByDay(conversations: ConversationWithLine[], days: number, offsetDays: number, language: Language): DayBucket[] {
  const buckets: DayBucket[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i - offsetDays)
    buckets.push({
      key: d.toDateString(),
      label: d.toLocaleDateString(language === 'en' ? 'en-US' : 'es-CO', { day: '2-digit', month: 'short' }),
      count: 0,
    })
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]))
  for (const c of conversations) {
    if (!c.last_message_at) continue
    const bucket = byKey.get(new Date(c.last_message_at).toDateString())
    if (bucket) bucket.count += 1
  }
  return buckets
}

/** Same day-bucketing idea as `bucketByDay`, generalized to sum an arbitrary
 * numeric value instead of just counting rows -- used by the KPI cards
 * (ventas sums order totals, pedidos/despachos just count with
 * `getValue: () => 1`). Same `offsetDays` trick as `bucketByDay`: shifts the
 * whole window into the past so the same function builds both the current
 * period (for the sparkline) and the immediately-preceding one (for the "vs
 * período anterior" delta on Ventas) without a second implementation. */
function valueByDay<T>(items: T[], days: number, offsetDays: number, language: Language, getDateIso: (item: T) => string, getValue: (item: T) => number): DayValueBucket[] {
  const buckets: DayValueBucket[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i - offsetDays)
    buckets.push({
      key: d.toDateString(),
      label: d.toLocaleDateString(language === 'en' ? 'en-US' : 'es-CO', { day: '2-digit', month: 'short' }),
      value: 0,
    })
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]))
  for (const item of items) {
    const bucket = byKey.get(new Date(getDateIso(item)).toDateString())
    if (bucket) bucket.value += getValue(item)
  }
  return buckets
}

/** Average minutes between an inbound message and the next outbound one in
 * the same conversation, restricted to responses that landed inside
 * [windowStart, windowEnd) -- a real "tiempo promedio de respuesta" instead
 * of a fabricated number. Gaps over 24h are excluded (almost certainly a
 * contact re-opening a stale thread, not an agent/IA being slow). */
function computeAvgResponseMinutes(timings: MessageTiming[], windowStart: Date, windowEnd: Date): number | null {
  const byConversation = new Map<string, MessageTiming[]>()
  for (const t of timings) {
    const list = byConversation.get(t.conversation_id)
    if (list) list.push(t)
    else byConversation.set(t.conversation_id, [t])
  }

  const gaps: number[] = []
  for (const msgs of byConversation.values()) {
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1]
      const curr = msgs[i]
      if (prev.direction !== 'inbound' || curr.direction !== 'outbound') continue
      const respondedAt = new Date(curr.created_at)
      if (respondedAt < windowStart || respondedAt >= windowEnd) continue
      const gapMinutes = (respondedAt.getTime() - new Date(prev.created_at).getTime()) / 60_000
      if (gapMinutes >= 0 && gapMinutes <= 60 * 24) gaps.push(gapMinutes)
    }
  }
  if (gaps.length === 0) return null
  return gaps.reduce((sum, g) => sum + g, 0) / gaps.length
}

/** `invert` flips which sign reads as "good" -- more conversations is good
 * (positive = green), but a slower average response time is bad (positive =
 * red), even though both are rendered the same way otherwise. */
function Delta({ pct, invert = false }: { pct: number; invert?: boolean }) {
  const { t } = useLanguage()
  const isGood = invert ? pct <= 0 : pct >= 0
  return (
    <span className={`text-[11px] font-medium ${isGood ? 'text-green-600' : 'text-red-600'}`}>
      {pct >= 0 ? '↑' : '↓'}
      {Math.abs(pct)}% {t('dashboard.vsPreviousPeriod')}
    </span>
  )
}

function ConversationsChart({ days }: { days: DayBucket[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const max = Math.max(1, ...days.map((d) => d.count))
  const labelEvery = Math.max(1, Math.ceil(days.length / 7))

  return (
    <div>
      <div className="flex h-28 items-stretch gap-1">
        {days.map((d, i) => (
          <div
            key={d.key}
            className="relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHoverIndex(i)}
            onMouseLeave={() => setHoverIndex((h) => (h === i ? null : h))}
          >
            {hoverIndex === i && (
              <div className="absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-brand-800 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
                {d.count} · {d.label}
              </div>
            )}
            <div
              className={`w-full rounded-t transition-colors ${hoverIndex === i ? 'bg-accent-600' : 'bg-accent-500'}`}
              style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1">
        {days.map((d, i) => (
          <span key={d.key} className="flex-1 truncate text-center text-[9px] text-brand-300">
            {i % labelEvery === 0 ? d.label : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Colored per-stage tiles (tinted with the stage's own real color, see
 * migration 20260806000010) instead of a generic bar -- works for any
 * pipeline/stage set a tenant configures, not just the 6 default names,
 * since the tint is derived from `stage.color` rather than hardcoded. */
function PipelineStageTiles({
  stages,
  dataByStage,
  metric,
}: {
  stages: PipelineStage[]
  dataByStage: Map<string, { value: number; count: number }>
  metric: 'value' | 'count'
}) {
  const { t } = useLanguage()
  return (
    <div className="flex gap-1.5">
      {stages.map((stage) => {
        const data = dataByStage.get(stage.id) ?? { value: 0, count: 0 }
        return (
          <div key={stage.id} className="min-w-0 flex-1 rounded-lg p-2" style={{ backgroundColor: `${stage.color}14` }}>
            <p className="truncate text-[10px] font-medium" style={{ color: stage.color }}>
              {stage.name}
            </p>
            <p className="truncate text-sm font-bold text-brand-800">{metric === 'value' ? formatCompactCurrency(data.value) : String(data.count)}</p>
            <p className="truncate text-[10px] text-brand-400">{t('dashboard.pipeline.opportunityCount', { count: data.count })}</p>
          </div>
        )
      })}
    </div>
  )
}

/** Tiny inline trend line for a KPI card -- purely decorative (no axes/
 * tooltip, that's what the bigger charts elsewhere on the page are for).
 * `preserveAspectRatio="none"` so it stretches to fill whatever box the
 * card gives it instead of letterboxing. */
function Sparkline({ data, color }: { data: DayValueBucket[]; color: string }) {
  const values = data.map((d) => d.value)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const w = 100
  const h = 30
  const points = data
    .map((d, i) => {
      const x = data.length > 1 ? (i / (data.length - 1)) * w : w / 2
      const y = h - ((d.value - min) / range) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One of the 4 top KPI cards (ventas/pedidos/despachos/cartera). Ícono a la
 * izquierda del bloque de texto, no arriba -- corregido 2026-09-02, feedback
 * directo del usuario ("las tarjetas tienen el icono al lado izquierdo no
 * encima y las quiero mas compactas"): la primera versión apilaba
 * ícono/título/valor uno debajo del otro, más alta de lo que el mockup
 * mostraba. `sparkline` es opcional -- Cartera no tiene una (es un saldo
 * acumulado, no algo que sume día a día de forma honesta sin una consulta
 * nueva de todo el ledger histórico). */
function KpiCard({
  icon: Icon,
  tone,
  title,
  value,
  footer,
  sparkline,
}: {
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element
  tone: { bg: string; text: string; line: string }
  title: string
  value: string
  footer: React.ReactNode
  sparkline?: DayValueBucket[]
}) {
  return (
    <Card className="!p-3">
      <div className="flex items-center gap-2.5">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.bg} ${tone.text}`}>
          <Icon width={17} height={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] text-brand-400">{title}</p>
          <p className="truncate text-base font-bold leading-tight text-brand-800">{value}</p>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="min-h-[15px]">{footer}</div>
        {sparkline && (
          <div className="h-6 w-14 shrink-0">
            <Sparkline data={sparkline} color={tone.line} />
          </div>
        )}
      </div>
    </Card>
  )
}

export function Dashboard() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [messageTimings, setMessageTimings] = useState<MessageTiming[] | null>(null)
  const [stages, setStages] = useState<PipelineStage[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[] | null>(null)
  const [history, setHistory] = useState<StageHistoryRow[]>([])
  const [agentActivity, setAgentActivity] = useState<AgentActivitySummary[] | null>(null)
  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [returns, setReturns] = useState<ReturnWithOrder[] | null>(null)
  const [dispatches, setDispatches] = useState<Pick<Dispatch, 'id' | 'created_at'>[] | null>(null)
  const [creditClients, setCreditClients] = useState<ClientCreditSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rangeDays, setRangeDays] = useState<RangeDays>(7)
  // Filtro de fecha del header -- independiente del selector de la tarjeta
  // de Conversaciones (`rangeDays` arriba), pedido explícito del usuario
  // (2026-09-02): "el filtro de fecha deberia ser funcional". Escala
  // Ventas/Pedidos/Despachos (cada uno "creado dentro de los últimos N
  // días"); Cartera se queda fuera a propósito -- es un saldo vivo ahora
  // mismo, no algo que tenga sentido acotar a un período.
  const [kpiRangeDays, setKpiRangeDays] = useState<RangeDays>(7)
  const [pipelineMetric, setPipelineMetric] = useState<'value' | 'count'>('value')

  useEffect(() => {
    if (!profile?.tenant_id) return
    const tenantId = profile.tenant_id

    listTasks(tenantId).then(setTasks).catch(() => setTasks([]))
    listOrders(tenantId).then(setOrders).catch(() => setOrders([]))
    listReturns(tenantId).then(setReturns).catch(() => setReturns([]))
    listDispatchesForTenant(tenantId).then(setDispatches).catch(() => setDispatches([]))
    listCreditClients(tenantId).then(setCreditClients).catch(() => setCreditClients([]))

    // Rendimiento del equipo -- solo tenant_admin lo ve (Fase 4, pedido
    // explícito del usuario), un tenant_agent no necesita ver cómo le va a
    // sus compañeros.
    if (profile?.role === 'tenant_admin') {
      getAgentActivitySummary(tenantId)
        .then(setAgentActivity)
        .catch(() => setAgentActivity([]))
    }

    listConversations(tenantId)
      .then((convs) => {
        setConversations(convs)
        listMessageTimingsForConversations(convs.map((c) => c.id))
          .then(setMessageTimings)
          .catch(() => setMessageTimings([]))
      })
      .catch((err) => {
        setError(err.message ?? t('dashboard.errors.loadConversations'))
        setConversations([])
        setMessageTimings([])
      })

    getDefaultPipeline(tenantId)
      .then((pipeline) => {
        if (!pipeline) {
          setStages([])
          setOpportunities([])
          return
        }
        listStages(pipeline.id).then(setStages).catch(() => setStages([]))
        listOpportunities(tenantId, pipeline.id)
          .then((opps) => {
            setOpportunities(opps)
            listStageHistoryForOpportunities(opps.map((o) => o.id))
              .then(setHistory)
              .catch(() => setHistory([]))
          })
          .catch(() => setOpportunities([]))
      })
      .catch(() => setOpportunities([]))
  }, [profile?.tenant_id])

  const nowMs = Date.now()
  const isTaskOverdue = (task: TaskWithRelations) => new Date(task.due_date).getTime() < nowMs
  // Vencidas primero (Fase 2, 2026-09-02) -- antes se mostraban las 5 más
  // próximas en orden ciego de fecha, así que una tarea vencida podía
  // quedar afuera de las 5 mientras una futura sin urgencia sí aparecía.
  const upcomingTasks = (tasks ?? [])
    .filter((t) => t.status === 'pendiente' || t.status === 'en_proceso')
    .slice()
    .sort((a, b) => Number(isTaskOverdue(b)) - Number(isTaskOverdue(a)))
    .slice(0, 5)

  const dataByStage = useMemo(() => {
    const map = new Map<string, { value: number; count: number }>()
    for (const opp of opportunities ?? []) {
      const entry = map.get(opp.stage_id) ?? { value: 0, count: 0 }
      entry.value += opp.value
      entry.count += 1
      map.set(opp.stage_id, entry)
    }
    return map
  }, [opportunities])

  const metrics = useMemo(() => computePipelineMetrics(opportunities ?? [], history), [opportunities, history])

  const currentBuckets = useMemo(() => bucketByDay(conversations ?? [], rangeDays, 0, language), [conversations, rangeDays, language])
  const previousBuckets = useMemo(() => bucketByDay(conversations ?? [], rangeDays, rangeDays, language), [conversations, rangeDays, language])
  const totalCurrent = currentBuckets.reduce((sum, b) => sum + b.count, 0)
  const totalPrevious = previousBuckets.reduce((sum, b) => sum + b.count, 0)
  const totalDeltaPct = totalPrevious > 0 ? Math.round(((totalCurrent - totalPrevious) / totalPrevious) * 100) : null

  const avgResponseCurrent = useMemo(() => {
    if (!messageTimings) return null
    const windowEnd = new Date()
    const windowStart = new Date(windowEnd)
    windowStart.setDate(windowStart.getDate() - rangeDays)
    return computeAvgResponseMinutes(messageTimings, windowStart, windowEnd)
  }, [messageTimings, rangeDays])

  const avgResponsePrevious = useMemo(() => {
    if (!messageTimings) return null
    const windowEnd = new Date()
    windowEnd.setDate(windowEnd.getDate() - rangeDays)
    const windowStart = new Date(windowEnd)
    windowStart.setDate(windowStart.getDate() - rangeDays)
    return computeAvgResponseMinutes(messageTimings, windowStart, windowEnd)
  }, [messageTimings, rangeDays])

  const avgResponseDeltaPct =
    avgResponseCurrent !== null && avgResponsePrevious !== null && avgResponsePrevious > 0
      ? Math.round(((avgResponseCurrent - avgResponsePrevious) / avgResponsePrevious) * 100)
      : null

  // --- KPIs operativos (ventas/pedidos/despachos/cartera) -- pedido
  // explícito del usuario (2026-09-02): "esto no es un CRM, es la
  // plataforma que centraliza la operación de una empresa", el Dashboard
  // tenía que mostrarlo. Ventas/Pedidos/Despachos ahora sí quedan acotados
  // por `kpiRangeDays` (el selector del header, ya funcional) -- mismo
  // patrón exacto que ya usa Conversaciones (bucketByDay con offset 0 para
  // el período actual, offset = kpiRangeDays para el anterior). Cartera
  // queda deliberadamente afuera del filtro: es un saldo vivo ahora mismo,
  // no un flujo que tenga sentido acotar a "los últimos N días".
  const confirmedOrders = useMemo(() => (orders ?? []).filter((o) => o.status === 'confirmada'), [orders])
  const inProgressOrders = useMemo(() => confirmedOrders.filter((o) => o.delivery_status !== 'entregado'), [confirmedOrders])

  const salesTrend = useMemo(
    () => valueByDay(confirmedOrders, kpiRangeDays, 0, language, (o) => o.created_at, (o) => o.total),
    [confirmedOrders, kpiRangeDays, language],
  )
  const salesTrendPrevious = useMemo(
    () => valueByDay(confirmedOrders, kpiRangeDays, kpiRangeDays, language, (o) => o.created_at, (o) => o.total),
    [confirmedOrders, kpiRangeDays, language],
  )
  const salesInRange = salesTrend.reduce((sum, b) => sum + b.value, 0)
  const salesPrevRange = salesTrendPrevious.reduce((sum, b) => sum + b.value, 0)
  const salesDeltaPct = salesPrevRange > 0 ? Math.round(((salesInRange - salesPrevRange) / salesPrevRange) * 100) : null

  const ordersTrend = useMemo(
    () => valueByDay(inProgressOrders, kpiRangeDays, 0, language, (o) => o.created_at, () => 1),
    [inProgressOrders, kpiRangeDays, language],
  )
  const ordersInRange = ordersTrend.reduce((sum, b) => sum + b.value, 0)

  const dispatchesTrend = useMemo(
    () => valueByDay(dispatches ?? [], kpiRangeDays, 0, language, (d) => d.created_at, () => 1),
    [dispatches, kpiRangeDays, language],
  )
  const dispatchesInRange = dispatchesTrend.reduce((sum, b) => sum + b.value, 0)

  const receivableTotal = useMemo(() => (creditClients ?? []).reduce((sum, c) => sum + c.balance, 0), [creditClients])

  // --- Actividad reciente: pedidos + cotizaciones (misma tabla sales_orders,
  // distinguibles solo por status) y devoluciones, mezclados por fecha. No
  // incluye "Facturas" -- a diferencia del resto de esta tarjeta, facturar
  // al cliente final del tenant todavía no es un módulo real (ver
  // CLAUDE.md, "Facturación" en el nav es Leadly facturándole al tenant, no
  // el tenant facturando a sus propios clientes) -- omitido en vez de
  // inventar datos que no existen.
  type ActivityItem = { time: string } & ({ kind: 'order'; order: OrderWithRelations } | { kind: 'return'; ret: ReturnWithOrder })
  const recentActivity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [
      ...(orders ?? []).filter((o) => o.status !== 'cancelada').map((order): ActivityItem => ({ kind: 'order', order, time: order.created_at })),
      ...(returns ?? []).map((ret): ActivityItem => ({ kind: 'return', ret, time: ret.created_at })),
    ]
    items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    return items.slice(0, 6)
  }, [orders, returns])

  const firstName = profile?.full_name?.trim().split(/\s+/)[0] ?? ''

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-800">
            {t('dashboard.greeting.prefix')} <span className="text-accent-600">{firstName}</span>
          </h1>
          <p className="mt-0.5 text-sm text-brand-400">{t('dashboard.greeting.subtitle')}</p>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-brand-100 bg-white px-2.5 py-1">
          <CalendarIcon width={14} height={14} className="shrink-0 text-brand-400" />
          <Select value={kpiRangeDays} onChange={(e) => setKpiRangeDays(Number(e.target.value) as RangeDays)} className="!w-auto !border-0 !p-0 text-xs font-medium text-brand-600 focus:!ring-0">
            <option value={7}>{t('dashboard.conversations.range.7')}</option>
            <option value={14}>{t('dashboard.conversations.range.14')}</option>
            <option value={30}>{t('dashboard.conversations.range.30')}</option>
          </Select>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={DollarIcon}
          tone={{ bg: 'bg-emerald-50', text: 'text-emerald-600', line: '#10b981' }}
          title={t('dashboard.kpi.sales.title', { days: kpiRangeDays })}
          value={formatFullCurrency(salesInRange)}
          footer={salesDeltaPct !== null ? <Delta pct={salesDeltaPct} /> : <span className="text-[11px] text-brand-300">{t('dashboard.vsPreviousPeriod')}</span>}
          sparkline={salesTrend}
        />
        <KpiCard
          icon={ReceiptIcon}
          tone={{ bg: 'bg-violet-50', text: 'text-violet-600', line: '#8b5cf6' }}
          title={t('dashboard.kpi.orders.title', { days: kpiRangeDays })}
          value={String(ordersInRange)}
          footer={
            <Link to="/app/sales" className="text-[11px] font-medium text-sky-600 hover:text-sky-700">
              {t('common.actions.viewAll')}
            </Link>
          }
          sparkline={ordersTrend}
        />
        <KpiCard
          icon={TruckIcon}
          tone={{ bg: 'bg-sky-50', text: 'text-sky-600', line: '#0ea5e9' }}
          title={t('dashboard.kpi.dispatches.title', { days: kpiRangeDays })}
          value={String(dispatchesInRange)}
          footer={
            <Link to="/app/sales" className="text-[11px] font-medium text-sky-600 hover:text-sky-700">
              {t('common.actions.viewAll')}
            </Link>
          }
          sparkline={dispatchesTrend}
        />
        <KpiCard
          icon={WalletIcon}
          tone={{ bg: 'bg-amber-50', text: 'text-amber-600', line: '#f59e0b' }}
          title={t('dashboard.kpi.receivable.title')}
          value={formatFullCurrency(receivableTotal)}
          footer={
            <Link to="/app/credit" className="text-[11px] font-medium text-sky-600 hover:text-sky-700">
              {t('dashboard.kpi.receivable.footer')}
            </Link>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="!p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-brand-800">{t('dashboard.pipeline.title')}</h2>
            <Select value={pipelineMetric} onChange={(e) => setPipelineMetric(e.target.value as 'value' | 'count')} className="!w-auto !py-1 text-xs">
              <option value="value">{t('dashboard.pipeline.metric.value')}</option>
              <option value="count">{t('dashboard.pipeline.metric.count')}</option>
            </Select>
          </div>
          {stages.length === 0 && opportunities === null && <PageSpinner />}
          {opportunities !== null && stages.length === 0 && <EmptyState>{t('dashboard.pipeline.notConfigured')}</EmptyState>}
          {stages.length > 0 && (
            <>
              <PipelineStageTiles stages={stages} dataByStage={dataByStage} metric={pipelineMetric} />
              <div className="mt-3 rounded-lg border border-brand-100 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-brand-500">{t('dashboard.pipeline.conversion')}</span>
                  <span className="font-semibold text-brand-800">{metrics.conversionPct === null ? '—' : `${metrics.conversionPct.toFixed(1)}%`}</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-brand-100">
                  <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${metrics.conversionPct ?? 0}%` }} />
                </div>
              </div>
            </>
          )}
        </Card>

        <Card className="!p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-brand-800">{t('dashboard.conversations.title', { days: rangeDays })}</h2>
            <Select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value) as RangeDays)} className="!w-auto !py-1 text-xs">
              <option value={7}>{t('dashboard.conversations.range.7')}</option>
              <option value={14}>{t('dashboard.conversations.range.14')}</option>
              <option value={30}>{t('dashboard.conversations.range.30')}</option>
            </Select>
          </div>
          {!conversations && <PageSpinner />}
          {conversations && (
            <>
              <ConversationsChart days={currentBuckets} />
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-brand-100 pt-3">
                <div className="min-w-0">
                  <p className="text-[11px] text-brand-400">{t('dashboard.conversations.total')}</p>
                  <p className="text-lg font-bold text-brand-800">{totalCurrent}</p>
                  {totalDeltaPct !== null && <Delta pct={totalDeltaPct} />}
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-brand-400">{t('dashboard.conversations.avgResponseTime')}</p>
                  <p className="text-lg font-bold text-brand-800">{avgResponseCurrent !== null ? formatMinutes(avgResponseCurrent) : '—'}</p>
                  {avgResponseDeltaPct !== null && <Delta pct={avgResponseDeltaPct} invert />}
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="!p-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-brand-800">{t('dashboard.upcomingTasks.title')}</h2>
            <Link to="/app/calendar" className="text-xs font-medium text-accent-600 hover:text-accent-700">
              {t('common.actions.viewAll')}
            </Link>
          </div>
          {!tasks && <PageSpinner />}
          {tasks && upcomingTasks.length === 0 && <EmptyState>{t('dashboard.upcomingTasks.empty')}</EmptyState>}
          {tasks && upcomingTasks.length > 0 && (
            <ul className="space-y-1.5">
              {upcomingTasks.map((task) => {
                const overdue = isTaskOverdue(task)
                return (
                  <li key={task.id} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 ${overdue ? 'border-red-200 bg-red-50/40' : 'border-brand-100'}`}>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-brand-800">{task.title}</p>
                      <p className={`truncate text-[11px] ${overdue ? 'font-medium text-red-600' : 'text-brand-400'}`}>
                        {overdue && `${t('calendar.overdue')} · `}
                        {task.contact?.full_name ?? task.opportunity?.title ?? t('dashboard.upcomingTasks.generalTask')}
                        {task.due_date && ` · ${formatDate(task.due_date)}`}
                      </p>
                    </div>
                    <Badge tone={PRIORITY_TONE[task.priority]}>{t(TASK_PRIORITY_KEY[task.priority])}</Badge>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card className="!p-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-brand-800">{t('dashboard.recentActivity.title')}</h2>
            <Link to="/app/sales" className="text-xs font-medium text-accent-600 hover:text-accent-700">
              {t('common.actions.viewAll')}
            </Link>
          </div>
          {(!orders || !returns) && <PageSpinner />}
          {orders && returns && recentActivity.length === 0 && <EmptyState>{t('dashboard.recentActivity.empty')}</EmptyState>}
          {orders && returns && recentActivity.length > 0 && (
            <ul className="space-y-1.5">
              {recentActivity.map((item) => {
                if (item.kind === 'order') {
                  const o = item.order
                  const isQuote = o.status === 'cotizacion'
                  const badgeClass = isQuote ? ORDER_STATUS_BADGE_CLASS.cotizacion : DELIVERY_STATUS_BADGE_CLASS[o.delivery_status]
                  const badgeLabel = isQuote ? t(ORDER_STATUS_LABEL_KEY.cotizacion) : t(DELIVERY_STATUS_LABEL_KEY[o.delivery_status])
                  return (
                    <li key={`order-${o.id}`} className="flex items-center gap-2.5 rounded-lg border border-brand-100 px-3 py-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                        <ReceiptIcon width={15} height={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-brand-800">{t(isQuote ? 'dashboard.recentActivity.quote' : 'dashboard.recentActivity.order', { number: o.number })}</p>
                        <p className="truncate text-[11px] text-brand-400">{t('dashboard.recentActivity.client', { name: o.contact?.full_name ?? '—' })}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeClass}`}>{badgeLabel}</span>
                      <span className="hidden shrink-0 text-[11px] text-brand-300 sm:inline">{formatTime(o.created_at, language)}</span>
                    </li>
                  )
                }
                const r = item.ret
                return (
                  <li key={`return-${r.id}`} className="flex items-center gap-2.5 rounded-lg border border-brand-100 px-3 py-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-600">
                      <RefreshIcon width={15} height={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-brand-800">{t('dashboard.recentActivity.return', { number: r.sales_order?.number ?? '—' })}</p>
                      <p className="truncate text-[11px] text-brand-400">{t('dashboard.recentActivity.client', { name: r.sales_order?.contact?.full_name ?? '—' })}</p>
                    </div>
                    {r.status && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: `${r.status.color}1f`, color: r.status.color }}
                      >
                        {r.status.name}
                      </span>
                    )}
                    <span className="hidden shrink-0 text-[11px] text-brand-300 sm:inline">{formatTime(r.created_at, language)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>

      {profile?.role === 'tenant_admin' && (
        <Card className="!p-3.5">
          <div className="mb-2.5 flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-brand-800">{t('dashboard.agentActivity.title')}</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-brand-300 hover:text-brand-500">
                  <InfoIcon width={14} height={14} />
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('dashboard.agentActivity.tooltip')}</TooltipContent>
            </Tooltip>
          </div>
          {!agentActivity && <PageSpinner />}
          {agentActivity && agentActivity.length === 0 && <EmptyState>{t('dashboard.agentActivity.empty')}</EmptyState>}
          {agentActivity && agentActivity.length > 0 && (
            <ul className="space-y-3">
              {agentActivity.map((agent) => {
                const completedTotal = agent.tasks_completed_on_time + agent.tasks_completed_late
                const onTimePct = completedTotal > 0 ? Math.round((agent.tasks_completed_on_time / completedTotal) * 100) : null
                return (
                  <li key={agent.agent_id} className="rounded-lg border border-brand-100 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="text-xs font-semibold text-brand-800">{agent.agent_name}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-brand-400">
                        <span>
                          {t('dashboard.agentActivity.pending')}: <span className="font-semibold text-brand-700">{agent.tasks_pending}</span>
                        </span>
                        <span className={agent.tasks_overdue > 0 ? 'font-semibold text-red-600' : ''}>
                          {t('dashboard.agentActivity.tasksOverdue')}: {agent.tasks_overdue}
                        </span>
                        <span className={agent.appointments_overdue > 0 ? 'font-semibold text-red-600' : ''}>
                          {t('dashboard.agentActivity.appointmentsOverdue')}: {agent.appointments_overdue}
                        </span>
                        <span>
                          {t('dashboard.agentActivity.onTimeRate')}:{' '}
                          <span className="font-semibold text-brand-700">{onTimePct === null ? t('dashboard.agentActivity.noCompletedYet') : `${onTimePct}%`}</span>
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-brand-100">
                      <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${onTimePct ?? 0}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
