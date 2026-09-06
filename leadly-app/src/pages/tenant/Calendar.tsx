import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { listAppointmentsForTenantRange, updateAppointmentStatus } from '../../lib/api/appointments'
import { listTasksForTenantRange, updateTask } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import { listProfilesByTenant } from '../../lib/api/users'
import { useOpportunityStageGate } from '../../lib/useOpportunityStageGate'
import type { AppointmentStatus, AppointmentWithContact, Profile } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card, IconInput } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ChevronLeftIcon, FilterIcon, PlusIcon, SearchIcon } from '@/components/atoms/icons'
import { AppointmentFormDrawer, type AppointmentEditInitial } from './calendar/AppointmentFormDrawer'
import { AppointmentDetailDrawer } from './calendar/AppointmentDetailDrawer'
import { TaskDrawer } from './tasks/TaskDrawer'
import { AgendaSidePanel } from './calendar/AgendaSidePanel'
import { TimeGrid } from './calendar/TimeGrid'
import { CalendarListView } from './calendar/CalendarListView'
import {
  type CalendarEntry,
  type EntryType,
  addDays,
  addMonths,
  capitalizeFirst,
  dateKey,
  entryAssignedTo,
  entryId,
  entrySearchText,
  entryStatus,
  entryVisual,
  isEntryOpen,
  startOfDay,
  startOfGrid,
  startOfMonth,
  startOfWeek,
  toDatetimeLocalValue,
} from './calendar/agendaShared'

type ViewMode = 'month' | 'week' | 'day' | 'list'
type StatusFilter = '' | 'open' | 'completed' | 'cancelled'

const WEEKDAY_KEYS: TranslationKey[] = [
  'calendar.weekday.mon',
  'calendar.weekday.tue',
  'calendar.weekday.wed',
  'calendar.weekday.thu',
  'calendar.weekday.fri',
  'calendar.weekday.sat',
  'calendar.weekday.sun',
]

const VIEW_KEYS: Record<ViewMode, TranslationKey> = {
  month: 'calendar.view.month',
  week: 'calendar.view.week',
  day: 'calendar.view.day',
  list: 'calendar.view.list',
}

export function Calendar() {
  const { profile, enabledModules } = useAuth()
  const { t, language } = useLanguage()
  const tenantId = profile?.tenant_id ?? null
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const tasksEnabled = enabledModules?.has('tasks') ?? false
  const { requestStageDecision, dialog: stageGateDialog } = useOpportunityStageGate()

  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [typeFilter, setTypeFilter] = useState<'all' | EntryType>('all')
  const [mineOnly, setMineOnly] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersRef = useRef<HTMLDivElement>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [selectedDay, setSelectedDay] = useState(() => new Date())
  const [listRangeDays, setListRangeDays] = useState(30)
  const [appointments, setAppointments] = useState<AppointmentWithContact[] | null>(null)
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formDrawer, setFormDrawer] = useState<{ open: boolean; prefillDate?: Date; editing?: AppointmentEditInitial | null }>({ open: false })
  const [detailDrawer, setDetailDrawer] = useState<{ open: boolean; appointment: AppointmentWithContact | null }>({ open: false, appointment: null })
  const [taskDrawer, setTaskDrawer] = useState<{ open: boolean; task: TaskWithRelations | null; prefillDueDate?: string }>({ open: false, task: null })
  const [quickUpdating, setQuickUpdating] = useState<string | null>(null)

  useEffect(() => {
    if (!tenantId) return
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
  }, [tenantId])

  const month = useMemo(() => startOfMonth(anchorDate), [anchorDate])
  const week = useMemo(() => startOfWeek(anchorDate), [anchorDate])
  const day = useMemo(() => startOfDay(anchorDate), [anchorDate])

  // Rango visible según la vista activa -- month sigue trayendo semanas
  // completas, week trae 7 días desde el lunes, day trae un único día, y
  // list trae una ventana ancha hacia adelante ("Próximos N días") en vez de
  // un período calendario puntual.
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (viewMode === 'week') return { rangeStart: week, rangeEnd: addDays(week, 7) }
    if (viewMode === 'day') return { rangeStart: day, rangeEnd: addDays(day, 1) }
    if (viewMode === 'list') {
      const start = startOfDay(new Date())
      return { rangeStart: start, rangeEnd: addDays(start, listRangeDays) }
    }
    const gridStart = startOfGrid(month)
    const gridEnd = startOfGrid(addMonths(month, 1))
    return { rangeStart: gridStart, rangeEnd: gridEnd }
  }, [viewMode, month, week, day, listRangeDays])

  const gridDays = useMemo(() => {
    const days: Date[] = []
    for (let d = rangeStart; d < rangeEnd; d = addDays(d, 1)) days.push(d)
    return days
  }, [rangeStart, rangeEnd])

  function reload() {
    if (!tenantId) return
    listAppointmentsForTenantRange(tenantId, rangeStart.toISOString(), rangeEnd.toISOString())
      .then(setAppointments)
      .catch((err) => setError(err.message ?? t('calendar.errors.loadFailed')))
    if (tasksEnabled) {
      listTasksForTenantRange(tenantId, rangeStart.toISOString(), rangeEnd.toISOString())
        .then(setTasks)
        .catch((err) => setError(err.message ?? t('calendar.errors.loadFailed')))
    } else {
      setTasks([])
    }
  }

  useEffect(reload, [tenantId, rangeStart, rangeEnd, tasksEnabled])

  useEffect(() => {
    if (!filtersOpen) return
    function handleClick(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [filtersOpen])

  // El día seleccionado del panel "Agenda del día" sigue al mes visible: si
  // hoy cae dentro del mes que se está mirando lo preselecciona, si no cae
  // en el primer día -- nunca deja seleccionado un día de un mes distinto.
  useEffect(() => {
    if (viewMode !== 'month') return
    if (selectedDay.getMonth() === month.getMonth() && selectedDay.getFullYear() === month.getFullYear()) return
    const today = new Date()
    setSelectedDay(today.getMonth() === month.getMonth() && today.getFullYear() === month.getFullYear() ? today : month)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, viewMode])

  // El calendario es la "matriz" del CRM: citas y tareas conviven en la
  // misma grilla en vez de vivir en módulos separados -- se combinan acá en
  // un único feed filtrado (tipo, responsable, estado, texto) y ordenado por
  // hora.
  const allEntries = useMemo(() => {
    const list: CalendarEntry[] = []
    if (typeFilter !== 'task') {
      for (const appt of appointments ?? []) list.push({ kind: 'appointment', time: new Date(appt.scheduled_at).getTime(), appointment: appt })
    }
    if (typeFilter !== 'appointment') {
      for (const task of tasks ?? []) list.push({ kind: 'task', time: new Date(task.due_date).getTime(), task })
    }
    const query = searchQuery.trim().toLowerCase()
    return list.filter((entry) => {
      if (mineOnly && entryAssignedTo(entry) !== profile?.id) return false
      if (ownerFilter && entryAssignedTo(entry) !== ownerFilter) return false
      if (statusFilter === 'open' && !isEntryOpen(entry)) return false
      if (statusFilter === 'completed' && entryStatus(entry) !== 'completada') return false
      if (statusFilter === 'cancelled' && entryStatus(entry) !== 'cancelada') return false
      if (query && !entrySearchText(entry).includes(query)) return false
      return true
    })
  }, [appointments, tasks, typeFilter, mineOnly, ownerFilter, statusFilter, searchQuery, profile?.id])

  const entriesByDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of allEntries) {
      const key = dateKey(new Date(entry.time))
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(entry)
    }
    for (const list of map.values()) list.sort((a, b) => a.time - b.time)
    return map
  }, [allEntries])

  function upsertAppointment(updated: AppointmentWithContact) {
    setAppointments((prev) => {
      if (!prev) return [updated]
      const exists = prev.some((a) => a.id === updated.id)
      return exists ? prev.map((a) => (a.id === updated.id ? updated : a)) : [...prev, updated]
    })
  }

  function upsertTask(updated: TaskWithRelations) {
    setTasks((prev) => {
      if (!prev) return [updated]
      const exists = prev.some((x) => x.id === updated.id)
      return exists ? prev.map((x) => (x.id === updated.id ? updated : x)) : [...prev, updated]
    })
  }

  async function doSetAppointmentStatus(appt: AppointmentWithContact, status: AppointmentStatus) {
    setQuickUpdating(appt.id)
    try {
      const updated = await updateAppointmentStatus(appt.id, status)
      upsertAppointment({ ...updated, contact_full_name: appt.contact_full_name, assignee_full_name: appt.assignee_full_name, opportunity_title: appt.opportunity_title })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('calendar.errors.updateFailed'))
    } finally {
      setQuickUpdating(null)
    }
  }

  // Completar una cita/tarea con oportunidad vinculada exige decidir antes
  // qué pasa con esa oportunidad (pedido explícito del usuario, 2026-09-06) --
  // cancelar o des-completar no pasan por el gate, solo el camino hacia
  // 'completada'.
  function quickSetAppointmentStatus(appt: AppointmentWithContact, status: AppointmentStatus) {
    if (status === 'completada' && appt.opportunity_id) {
      requestStageDecision(appt.opportunity_id, appt.contact_full_name ?? t('calendar.detail.contactFallback'), () => doSetAppointmentStatus(appt, status))
      return
    }
    doSetAppointmentStatus(appt, status)
  }

  async function doToggleTask(task: TaskWithRelations) {
    setQuickUpdating(task.id)
    try {
      const updated = await updateTask(task.id, { due_date: task.due_date, status: task.status === 'completada' ? 'pendiente' : 'completada' })
      upsertTask({ ...task, ...updated })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks.errors.updateFailed'))
    } finally {
      setQuickUpdating(null)
    }
  }

  function quickToggleTask(task: TaskWithRelations) {
    if (task.status !== 'completada' && task.opportunity_id) {
      requestStageDecision(task.opportunity_id, task.title, () => doToggleTask(task))
      return
    }
    doToggleTask(task)
  }

  function openEntry(entry: CalendarEntry) {
    if (entry.kind === 'appointment') setDetailDrawer({ open: true, appointment: entry.appointment })
    else setTaskDrawer({ open: true, task: entry.task })
  }

  function openReschedule(appt: AppointmentWithContact) {
    setDetailDrawer({ open: false, appointment: null })
    setFormDrawer({
      open: true,
      editing: {
        id: appt.id,
        contactId: appt.contact_id,
        scheduledAt: appt.scheduled_at,
        endsAt: appt.ends_at,
        notes: appt.notes ?? '',
        assignedTo: appt.assigned_to,
        opportunityId: appt.opportunity_id,
        assigneeFullName: appt.assignee_full_name,
      },
    })
  }

  function openCreateAppointment(prefillDate?: Date) {
    setFormDrawer({ open: true, prefillDate })
  }

  function openCreateTask(prefillDueDate?: Date) {
    setTaskDrawer({ open: true, task: null, prefillDueDate: prefillDueDate ? toDatetimeLocalValue(prefillDueDate.toISOString()) : undefined })
  }

  function navigate(delta: number) {
    if (viewMode === 'month') setAnchorDate((d) => addMonths(startOfMonth(d), delta))
    else if (viewMode === 'week') setAnchorDate((d) => addDays(d, delta * 7))
    else setAnchorDate((d) => addDays(d, delta))
  }

  const today = new Date()
  const todayKey = dateKey(today)
  const nowMs = today.getTime()
  const hasActiveFilters = !!ownerFilter || !!statusFilter

  const headerLabel = useMemo(() => {
    if (viewMode === 'list') return t('calendar.list.range.label', { days: listRangeDays })
    if (viewMode === 'day') return capitalizeFirst(day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
    if (viewMode === 'week') {
      const weekEnd = addDays(week, 6)
      const sameMonth = week.getMonth() === weekEnd.getMonth()
      const startLabel = week.toLocaleDateString(locale, { day: 'numeric', month: sameMonth ? undefined : 'short' })
      const endLabel = weekEnd.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
      return `${startLabel} – ${endLabel}`
    }
    return capitalizeFirst(month.toLocaleDateString(locale, { month: 'long', year: 'numeric' }))
  }, [viewMode, day, week, month, locale, listRangeDays, t])

  const loaded = appointments !== null && tasks !== null

  if (!tenantId) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-3">
      <div>
        <h1 className="text-sm font-bold text-brand-800">{t('calendar.pageTitle')}</h1>
        <p className="text-xs text-brand-400">{t('calendar.pageSubtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => navigate(-1)} aria-label={t('calendar.aria.prev')} disabled={viewMode === 'list'}>
            <ChevronLeftIcon width={16} height={16} />
          </Button>
          <h2 className="min-w-0 truncate text-xs font-bold text-brand-800">{headerLabel}</h2>
          <Button variant="outline" size="icon-sm" onClick={() => navigate(1)} aria-label={t('calendar.aria.next')} disabled={viewMode === 'list'}>
            <ChevronLeftIcon width={16} height={16} className="rotate-180" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchorDate(new Date())} disabled={viewMode === 'list'}>
            {t('calendar.today')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-brand-100 bg-white p-0.5">
            {(['month', 'week', 'day', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setViewMode(v)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === v ? 'bg-accent-500 text-white' : 'text-brand-500 hover:bg-brand-50'
                }`}
              >
                {t(VIEW_KEYS[v])}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <PlusIcon width={14} height={14} /> {t('calendar.actions.create')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openCreateAppointment(viewMode === 'month' ? undefined : anchorDate)}>{t('calendar.actions.createAppointment')}</DropdownMenuItem>
              {tasksEnabled && <DropdownMenuItem onSelect={() => openCreateTask(viewMode === 'month' ? undefined : anchorDate)}>{t('calendar.actions.createTask')}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <IconInput
          icon={<SearchIcon width={14} height={14} />}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('calendar.search.placeholder')}
          className="!h-8 w-56 !rounded-lg !text-xs"
        />
        <div className="flex items-center rounded-lg border border-brand-100 bg-white p-0.5">
          {(['all', 'appointment', 'task'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setTypeFilter(f)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                typeFilter === f ? 'bg-accent-500 text-white' : 'text-brand-500 hover:bg-brand-50'
              }`}
            >
              {t(f === 'all' ? 'calendar.filter.all' : f === 'appointment' ? 'calendar.filter.appointments' : 'calendar.filter.tasks')}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setMineOnly((v) => !v)}
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
            mineOnly ? 'border-accent-500 bg-accent-500 text-white' : 'border-brand-100 bg-white text-brand-500 hover:bg-brand-50'
          }`}
        >
          {t('calendar.filter.mine')}
        </button>

        <div ref={filtersRef} className="relative">
          <Button type="button" variant={hasActiveFilters ? 'secondary' : 'outline'} size="sm" onClick={() => setFiltersOpen((o) => !o)}>
            <FilterIcon width={13} height={13} />
            {t('calendar.filters.toggle')}
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </Button>

          {filtersOpen && (
            <div className="absolute left-0 top-full z-40 mt-2 w-56 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-brand-100 bg-white p-4 shadow-lg">
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('calendar.filters.owner.label')}</label>
                <Select value={ownerFilter || 'all'} onValueChange={(v) => setOwnerFilter(v === 'all' ? '' : v)}>
                  <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">
                      {t('calendar.filters.owner.all')}
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id} className="text-xs">
                        {a.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('calendar.filters.status.label')}</label>
                <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : (v as StatusFilter))}>
                  <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">
                      {t('calendar.filters.status.all')}
                    </SelectItem>
                    <SelectItem value="open" className="text-xs">
                      {t('calendar.filters.status.open')}
                    </SelectItem>
                    <SelectItem value="completed" className="text-xs">
                      {t('calendar.filters.status.completed')}
                    </SelectItem>
                    <SelectItem value="cancelled" className="text-xs">
                      {t('calendar.filters.status.cancelled')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setOwnerFilter('')
                    setStatusFilter('')
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-700"
                >
                  {t('common.actions.clearFilters')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-brand-400">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-sky-500" />
            {t('calendar.type.appointment')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-violet-500" />
            {t('calendar.type.task')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            {t('calendar.overdue')}
          </span>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {!loaded && <PageSpinner />}

      {loaded && viewMode === 'month' && (
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Card padded={false} className="overflow-hidden">
            <div className="grid grid-cols-7 border-b border-brand-100 bg-brand-50/50">
              {WEEKDAY_KEYS.map((key) => (
                <div key={key} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-brand-400">
                  {t(key)}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {gridDays.map((d) => {
                const key = dateKey(d)
                const isCurrentMonth = d.getMonth() === month.getMonth()
                const isToday = key === todayKey
                const isSelected = key === dateKey(selectedDay)
                const dayEntries = entriesByDay.get(key) ?? []
                const visible = dayEntries.slice(0, 3)
                const overflow = dayEntries.length - visible.length

                return (
                  <div
                    key={key}
                    onClick={() => setSelectedDay(d)}
                    className={`relative min-h-[100px] cursor-pointer border-b border-r border-brand-50 p-1.5 transition-colors last:border-r-0 hover:bg-accent-50/40 ${
                      isCurrentMonth ? 'bg-white' : 'bg-brand-50/40'
                    } ${isSelected ? 'ring-2 ring-inset ring-accent-300' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          isToday ? 'bg-accent-500 text-white' : isCurrentMonth ? 'text-brand-700' : 'text-brand-300'
                        }`}
                      >
                        {d.getDate()}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          openCreateAppointment(d)
                        }}
                        aria-label={t('calendar.actions.createAppointment')}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-brand-300 hover:bg-brand-100 hover:text-brand-600"
                      >
                        <PlusIcon width={12} height={12} />
                      </button>
                    </div>
                    <div className="mt-1 space-y-1">
                      {visible.map((entry) => {
                        const overdue = entry.time < nowMs && isEntryOpen(entry)
                        const status = entry.kind === 'appointment' ? entry.appointment.status : entry.task.status
                        const { dot, chip } = entryVisual(entry.kind, status, overdue)
                        const label = entry.kind === 'appointment' ? entry.appointment.contact_full_name : entry.task.title
                        return (
                          <button
                            key={entryId(entry)}
                            onClick={(e) => {
                              e.stopPropagation()
                              openEntry(entry)
                            }}
                            className={`flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[10px] font-medium transition-colors ${chip}`}
                          >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                            <span className="truncate">
                              {new Date(entry.time).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })} {label}
                            </span>
                          </button>
                        )
                      })}
                      {overflow > 0 && <p className="px-1.5 text-[10px] text-brand-400">{t('calendar.moreCount', { count: overflow })}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <AgendaSidePanel
            mode="day-agenda"
            day={selectedDay}
            entries={entriesByDay.get(dateKey(selectedDay)) ?? []}
            locale={locale}
            nowMs={nowMs}
            quickUpdating={quickUpdating}
            onOpenEntry={openEntry}
            onCompleteAppointment={(entry) => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'completada')}
            onCancelAppointment={(entry) => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'cancelada')}
            onToggleTask={(entry) => entry.kind === 'task' && quickToggleTask(entry.task)}
            onToggleAppointment={(entry) => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, entry.appointment.status === 'completada' ? 'activa' : 'completada')}
            onViewAll={() => setViewMode('list')}
          />
        </div>
      )}

      {loaded && viewMode === 'week' && (
        <TimeGrid
          days={gridDays}
          entriesByDay={entriesByDay}
          locale={locale}
          todayKey={todayKey}
          onEntryClick={openEntry}
          onSlotClick={(d, hour, minute) => {
            const prefill = new Date(d)
            prefill.setHours(hour, minute, 0, 0)
            openCreateAppointment(prefill)
          }}
        />
      )}

      {loaded && viewMode === 'day' && (
        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <TimeGrid
            days={[day]}
            entriesByDay={entriesByDay}
            locale={locale}
            todayKey={todayKey}
            onEntryClick={openEntry}
            onSlotClick={(d, hour, minute) => {
              const prefill = new Date(d)
              prefill.setHours(hour, minute, 0, 0)
              openCreateAppointment(prefill)
            }}
          />
          <AgendaSidePanel
            mode="day-progress"
            day={day}
            entries={entriesByDay.get(dateKey(day)) ?? []}
            locale={locale}
            nowMs={nowMs}
            quickUpdating={quickUpdating}
            onOpenEntry={openEntry}
            onCompleteAppointment={(entry) => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'completada')}
            onCancelAppointment={(entry) => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'cancelada')}
            onToggleTask={(entry) => entry.kind === 'task' && quickToggleTask(entry.task)}
            onToggleAppointment={(entry) => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, entry.appointment.status === 'completada' ? 'activa' : 'completada')}
          />
        </div>
      )}

      {loaded && viewMode === 'list' && (
        <CalendarListView
          rangeStart={rangeStart}
          entriesByDay={entriesByDay}
          rangeDays={listRangeDays}
          onRangeDaysChange={setListRangeDays}
          locale={locale}
          nowMs={nowMs}
          todayKey={todayKey}
          onOpenEntry={openEntry}
        />
      )}

      <AppointmentFormDrawer
        open={formDrawer.open}
        onClose={() => setFormDrawer({ open: false })}
        tenantId={tenantId}
        prefillDate={formDrawer.prefillDate}
        editing={formDrawer.editing}
        onSaved={upsertAppointment}
      />

      <AppointmentDetailDrawer
        open={detailDrawer.open}
        onClose={() => setDetailDrawer({ open: false, appointment: null })}
        appointment={detailDrawer.appointment}
        onChanged={upsertAppointment}
        onReschedule={openReschedule}
      />

      {tasksEnabled && (
        <TaskDrawer
          open={taskDrawer.open}
          onClose={() => setTaskDrawer({ open: false, task: null })}
          tenantId={tenantId}
          task={taskDrawer.task}
          prefillDueDate={taskDrawer.prefillDueDate}
          onSaved={reload}
        />
      )}

      {stageGateDialog}
    </div>
  )
}
