import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { listTasks, TASK_PRIORITY_KEY, type TaskWithRelations } from '../../lib/api/tasks'
import {
  conversationDisplayName,
  listConversations,
  listMessageTimingsForConversations,
  type ConversationWithLine,
  type MessageTiming,
} from '../../lib/api/conversations'
import {
  computePipelineMetrics,
  getDefaultPipeline,
  listOpportunities,
  listStageHistoryForOpportunities,
  listStages,
  type OpportunityWithRelations,
  type StageHistoryRow,
} from '../../lib/api/opportunities'
import type { PipelineStage, OpportunityPriority } from '../../types/domain'
import { Badge, PageSpinner, Select } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { PhoneIcon } from '@/components/atoms/icons'
const PRIORITY_TONE: Record<OpportunityPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }
type RangeDays = 7 | 14 | 30

function formatCompactCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

function formatShortDate(iso: string, language: Language): string {
  return new Date(iso).toLocaleDateString(language === 'en' ? 'en-US' : 'es-CO', { day: '2-digit', month: 'short' })
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

export function Dashboard() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [messageTimings, setMessageTimings] = useState<MessageTiming[] | null>(null)
  const [stages, setStages] = useState<PipelineStage[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[] | null>(null)
  const [history, setHistory] = useState<StageHistoryRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [rangeDays, setRangeDays] = useState<RangeDays>(7)
  const [pipelineMetric, setPipelineMetric] = useState<'value' | 'count'>('value')

  useEffect(() => {
    if (!profile?.tenant_id) return
    const tenantId = profile.tenant_id

    listTasks(tenantId).then(setTasks).catch(() => setTasks([]))

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

  const upcomingTasks = (tasks ?? []).filter((t) => t.status === 'pendiente' || t.status === 'en_proceso').slice(0, 5)
  const recentConversations = (conversations ?? []).slice(0, 5)

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

  return (
    <div className="space-y-3">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

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
            <Link to="/app/tasks" className="text-xs font-medium text-accent-600 hover:text-accent-700">
              {t('common.actions.viewAll')}
            </Link>
          </div>
          {!tasks && <PageSpinner />}
          {tasks && upcomingTasks.length === 0 && <EmptyState>{t('dashboard.upcomingTasks.empty')}</EmptyState>}
          {tasks && upcomingTasks.length > 0 && (
            <ul className="space-y-1.5">
              {upcomingTasks.map((task) => (
                <li key={task.id} className="flex items-start justify-between gap-3 rounded-lg border border-brand-100 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-brand-800">{task.title}</p>
                    <p className="truncate text-[11px] text-brand-400">
                      {task.contact?.full_name ?? task.opportunity?.title ?? t('dashboard.upcomingTasks.generalTask')}
                      {task.due_date && ` · ${formatShortDate(task.due_date, language)}`}
                    </p>
                  </div>
                  <Badge tone={PRIORITY_TONE[task.priority]}>{t(TASK_PRIORITY_KEY[task.priority])}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="!p-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-brand-800">{t('dashboard.recentConversations.title')}</h2>
            <Link to="/app" className="text-xs font-medium text-accent-600 hover:text-accent-700">
              {t('common.actions.viewAll')}
            </Link>
          </div>
          {!conversations && <PageSpinner />}
          {conversations && recentConversations.length === 0 && <EmptyState>{t('dashboard.recentConversations.empty')}</EmptyState>}
          {conversations && recentConversations.length > 0 && (
            <ul className="space-y-1.5">
              {recentConversations.map((conv) => (
                <li key={conv.id}>
                  <button
                    onClick={() => navigate(`/app?c=${conv.id}`)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-brand-100 px-3 py-2 text-left transition-colors hover:bg-brand-50"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                        <PhoneIcon width={13} height={13} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-brand-800">{conversationDisplayName(conv)}</span>
                        <span className="flex items-center gap-1.5 text-[11px] text-brand-400">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${conv.mode === 'ia' ? 'bg-accent-500' : 'bg-amber-500'}`} />
                          {conv.mode === 'ia' ? t('inbox.mode.ia') : t('inbox.mode.humano')}
                        </span>
                      </span>
                    </span>
                    {conv.last_message_at && <span className="shrink-0 text-[11px] text-brand-300">{formatTime(conv.last_message_at, language)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
