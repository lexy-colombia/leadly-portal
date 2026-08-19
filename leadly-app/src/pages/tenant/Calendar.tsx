import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { listAppointmentsForTenantRange, updateAppointmentStatus } from '../../lib/api/appointments'
import { listTasksForTenantRange, updateTask } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import type { AppointmentStatus, AppointmentWithContact, TaskStatus } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { ChevronLeftIcon, PlusIcon, CheckIcon, XCircleIcon } from '@/components/atoms/icons'
import { AppointmentFormDrawer, type AppointmentEditInitial } from './calendar/AppointmentFormDrawer'
import { AppointmentDetailDrawer } from './calendar/AppointmentDetailDrawer'
import { TaskDrawer } from './tasks/TaskDrawer'

type ViewMode = 'month' | 'week' | 'day'

type CalendarEntry =
  | { kind: 'appointment'; time: number; appointment: AppointmentWithContact }
  | { kind: 'task'; time: number; task: TaskWithRelations }

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
}

const APPOINTMENT_STATUS_DOT: Record<AppointmentStatus, string> = {
  activa: 'bg-amber-500',
  completada: 'bg-emerald-500',
  cancelada: 'bg-brand-300',
}

const APPOINTMENT_STATUS_CHIP: Record<AppointmentStatus, string> = {
  activa: 'bg-amber-50 text-amber-700 hover:bg-amber-100',
  completada: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  cancelada: 'bg-brand-50 text-brand-400 hover:bg-brand-100 line-through',
}

const TASK_STATUS_DOT: Record<TaskStatus, string> = {
  pendiente: 'bg-violet-500',
  en_proceso: 'bg-blue-500',
  completada: 'bg-emerald-500',
  cancelada: 'bg-brand-300',
}

const TASK_STATUS_CHIP: Record<TaskStatus, string> = {
  pendiente: 'bg-violet-50 text-violet-700 hover:bg-violet-100',
  en_proceso: 'bg-blue-50 text-blue-700 hover:bg-blue-100',
  completada: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  cancelada: 'bg-brand-50 text-brand-400 hover:bg-brand-100 line-through',
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

/** Monday-first: shifts Sunday (getDay()===0) to the end of the week. */
function mondayOffset(d: Date): number {
  const weekday = d.getDay()
  return weekday === 0 ? 6 : weekday - 1
}

function startOfGrid(monthStart: Date): Date {
  return addDays(monthStart, -mondayOffset(monthStart))
}

function startOfWeek(d: Date): Date {
  return startOfDay(addDays(d, -mondayOffset(d)))
}

/** CSS `capitalize` uppercases every word ("agosto de 2026" -> "Agosto De
 * 2026", wrong in Spanish) -- this only uppercases the first letter, same as
 * how a human would title a date. */
function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Calendar() {
  const { profile, enabledModules } = useAuth()
  const { t, language } = useLanguage()
  const tenantId = profile?.tenant_id ?? null
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const tasksEnabled = enabledModules?.has('tasks') ?? false

  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [appointments, setAppointments] = useState<AppointmentWithContact[] | null>(null)
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formDrawer, setFormDrawer] = useState<{ open: boolean; prefillDate?: Date; editing?: AppointmentEditInitial | null }>({ open: false })
  const [detailDrawer, setDetailDrawer] = useState<{ open: boolean; appointment: AppointmentWithContact | null }>({ open: false, appointment: null })
  const [taskDrawer, setTaskDrawer] = useState<{ open: boolean; task: TaskWithRelations | null; prefillDueDate?: string }>({ open: false, task: null })
  const [quickUpdating, setQuickUpdating] = useState<string | null>(null)

  const month = useMemo(() => startOfMonth(anchorDate), [anchorDate])
  const week = useMemo(() => startOfWeek(anchorDate), [anchorDate])
  const day = useMemo(() => startOfDay(anchorDate), [anchorDate])

  // Rango visible según la vista activa -- month sigue trayendo semanas
  // completas (incluye días del mes anterior/siguiente para llenar la
  // grilla), week trae 7 días desde el lunes, day trae un único día.
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (viewMode === 'week') return { rangeStart: week, rangeEnd: addDays(week, 7) }
    if (viewMode === 'day') return { rangeStart: day, rangeEnd: addDays(day, 1) }
    const gridStart = startOfGrid(month)
    const gridEnd = startOfGrid(addMonths(month, 1))
    return { rangeStart: gridStart, rangeEnd: gridEnd }
  }, [viewMode, month, week, day])

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

  // El calendario es la "matriz" del CRM (pedido explícito del usuario,
  // 2026-08-19): citas y tareas conviven en la misma grilla en vez de vivir
  // en módulos separados -- se combinan acá en un único feed por día,
  // ordenado por hora, distinguibles solo por el tipo de indicador (punto de
  // color = cita, círculo tipo checkbox = tarea, ver CalendarEntryRow).
  const entriesByDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const appt of appointments ?? []) {
      const key = dateKey(new Date(appt.scheduled_at))
      const entry: CalendarEntry = { kind: 'appointment', time: new Date(appt.scheduled_at).getTime(), appointment: appt }
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(entry)
    }
    for (const task of tasks ?? []) {
      const key = dateKey(new Date(task.due_date))
      const entry: CalendarEntry = { kind: 'task', time: new Date(task.due_date).getTime(), task }
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(entry)
    }
    for (const list of map.values()) list.sort((a, b) => a.time - b.time)
    return map
  }, [appointments, tasks])

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

  async function quickSetAppointmentStatus(appt: AppointmentWithContact, status: AppointmentStatus) {
    setQuickUpdating(appt.id)
    try {
      const updated = await updateAppointmentStatus(appt.id, status)
      upsertAppointment({ ...updated, contact_full_name: appt.contact_full_name })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('calendar.errors.updateFailed'))
    } finally {
      setQuickUpdating(null)
    }
  }

  async function quickToggleTask(task: TaskWithRelations) {
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

  function openReschedule(appt: AppointmentWithContact) {
    setDetailDrawer({ open: false, appointment: null })
    setFormDrawer({
      open: true,
      editing: { id: appt.id, contactId: appt.contact_id, dateTime: toDatetimeLocalValue(appt.scheduled_at), notes: appt.notes ?? '' },
    })
  }

  function navigate(delta: number) {
    if (viewMode === 'month') setAnchorDate((d) => addMonths(startOfMonth(d), delta))
    else if (viewMode === 'week') setAnchorDate((d) => addDays(d, delta * 7))
    else setAnchorDate((d) => addDays(d, delta))
  }

  const today = new Date()
  const todayKey = dateKey(today)

  const headerLabel = useMemo(() => {
    if (viewMode === 'day') return capitalizeFirst(day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
    if (viewMode === 'week') {
      const weekEnd = addDays(week, 6)
      const sameMonth = week.getMonth() === weekEnd.getMonth()
      const startLabel = week.toLocaleDateString(locale, { day: 'numeric', month: sameMonth ? undefined : 'short' })
      const endLabel = weekEnd.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
      return `${startLabel} – ${endLabel}`
    }
    return capitalizeFirst(month.toLocaleDateString(locale, { month: 'long', year: 'numeric' }))
  }, [viewMode, day, week, month, locale])

  const loaded = appointments !== null && tasks !== null

  if (!tenantId) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">{headerLabel}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-brand-100 bg-white p-0.5">
            {(['month', 'week', 'day'] as const).map((v) => (
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
          <Button variant="outline" size="icon-sm" onClick={() => navigate(-1)} aria-label={t('calendar.aria.prev')}>
            <ChevronLeftIcon width={16} height={16} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchorDate(new Date())}>
            {t('calendar.today')}
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => navigate(1)} aria-label={t('calendar.aria.next')}>
            <ChevronLeftIcon width={16} height={16} className="rotate-180" />
          </Button>
          {tasksEnabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTaskDrawer({ open: true, task: null, prefillDueDate: viewMode === 'month' ? undefined : toDatetimeLocalValue(anchorDate.toISOString()) })}
            >
              <PlusIcon width={14} height={14} /> {t('tasks.actions.new')}
            </Button>
          )}
          <Button size="sm" onClick={() => setFormDrawer({ open: true, prefillDate: viewMode === 'month' ? undefined : anchorDate })}>
            <PlusIcon width={14} height={14} /> {t('calendar.actions.new')}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!loaded && <PageSpinner />}

      {loaded && viewMode === 'month' && (
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
              const dayEntries = entriesByDay.get(key) ?? []
              const visible = dayEntries.slice(0, 3)
              const overflow = dayEntries.length - visible.length

              return (
                <div
                  key={key}
                  onClick={() => setFormDrawer({ open: true, prefillDate: d })}
                  className={`min-h-[100px] cursor-pointer border-b border-r border-brand-50 p-1.5 transition-colors last:border-r-0 hover:bg-accent-50/40 ${
                    isCurrentMonth ? 'bg-white' : 'bg-brand-50/40'
                  }`}
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                      isToday ? 'bg-accent-500 text-white' : isCurrentMonth ? 'text-brand-700' : 'text-brand-300'
                    }`}
                  >
                    {d.getDate()}
                  </span>
                  <div className="mt-1 space-y-1">
                    {visible.map((entry) => {
                      const entryKey = entry.kind === 'appointment' ? entry.appointment.id : entry.task.id
                      const chipClass = entry.kind === 'appointment' ? APPOINTMENT_STATUS_CHIP[entry.appointment.status] : TASK_STATUS_CHIP[entry.task.status]
                      const dotClass = entry.kind === 'appointment' ? APPOINTMENT_STATUS_DOT[entry.appointment.status] : TASK_STATUS_DOT[entry.task.status]
                      const label = entry.kind === 'appointment' ? entry.appointment.contact_full_name : entry.task.title
                      return (
                        <button
                          key={entryKey}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (entry.kind === 'appointment') setDetailDrawer({ open: true, appointment: entry.appointment })
                            else setTaskDrawer({ open: true, task: entry.task })
                          }}
                          className={`flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[10px] font-medium transition-colors ${chipClass}`}
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
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
      )}

      {loaded && viewMode === 'week' && (
        <Card padded={false} className="overflow-hidden">
          <div className="grid grid-cols-7">
            {gridDays.map((d) => {
              const key = dateKey(d)
              const isToday = key === todayKey
              const dayEntries = entriesByDay.get(key) ?? []

              return (
                <div key={key} className="min-h-[420px] border-r border-brand-50 last:border-r-0">
                  <div
                    onClick={() => setFormDrawer({ open: true, prefillDate: d })}
                    className={`cursor-pointer border-b border-brand-100 px-2 py-2 text-center transition-colors hover:bg-accent-50/40 ${isToday ? 'bg-accent-50' : 'bg-brand-50/50'}`}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-400">{t(WEEKDAY_KEYS[mondayOffset(d)])}</p>
                    <span
                      className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                        isToday ? 'bg-accent-500 text-white' : 'text-brand-700'
                      }`}
                    >
                      {d.getDate()}
                    </span>
                  </div>
                  <div className="space-y-1 p-1.5">
                    {dayEntries.map((entry) => (
                      <CalendarEntryRow
                        key={entry.kind === 'appointment' ? entry.appointment.id : entry.task.id}
                        entry={entry}
                        locale={locale}
                        compact
                        busy={quickUpdating === (entry.kind === 'appointment' ? entry.appointment.id : entry.task.id)}
                        onOpen={() =>
                          entry.kind === 'appointment' ? setDetailDrawer({ open: true, appointment: entry.appointment }) : setTaskDrawer({ open: true, task: entry.task })
                        }
                        onCompleteAppointment={() => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'completada')}
                        onCancelAppointment={() => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'cancelada')}
                        onToggleTask={() => entry.kind === 'task' && quickToggleTask(entry.task)}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {loaded && viewMode === 'day' && (
        <Card className="space-y-2">
          {(entriesByDay.get(dateKey(day)) ?? []).length === 0 && <p className="py-6 text-center text-sm text-brand-400">{t('calendar.day.empty')}</p>}
          {(entriesByDay.get(dateKey(day)) ?? []).map((entry) => (
            <CalendarEntryRow
              key={entry.kind === 'appointment' ? entry.appointment.id : entry.task.id}
              entry={entry}
              locale={locale}
              busy={quickUpdating === (entry.kind === 'appointment' ? entry.appointment.id : entry.task.id)}
              onOpen={() => (entry.kind === 'appointment' ? setDetailDrawer({ open: true, appointment: entry.appointment }) : setTaskDrawer({ open: true, task: entry.task }))}
              onCompleteAppointment={() => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'completada')}
              onCancelAppointment={() => entry.kind === 'appointment' && quickSetAppointmentStatus(entry.appointment, 'cancelada')}
              onToggleTask={() => entry.kind === 'task' && quickToggleTask(entry.task)}
            />
          ))}
        </Card>
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
    </div>
  )
}

/** Fila unificada de cita o tarea con acciones rápidas (completar/cancelar
 * una cita, o tildar una tarea) sin tener que abrir ningún drawer -- usada
 * en las vistas semana (compact) y día. Los botones siempre están visibles
 * (no ocultos tras :hover) porque el panel es mobile-first y el hover no
 * existe en touch. */
function CalendarEntryRow({
  entry,
  locale,
  compact,
  busy,
  onOpen,
  onCompleteAppointment,
  onCancelAppointment,
  onToggleTask,
}: {
  entry: CalendarEntry
  locale: string
  compact?: boolean
  busy: boolean
  onOpen: () => void
  onCompleteAppointment: () => void
  onCancelAppointment: () => void
  onToggleTask: () => void
}) {
  const { t } = useLanguage()
  const isTask = entry.kind === 'task'
  const time = new Date(entry.time).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const label = isTask ? entry.task.title : entry.appointment.contact_full_name
  const struckThrough = isTask ? entry.task.status === 'cancelada' : entry.appointment.status === 'cancelada'
  const dotClass = isTask ? TASK_STATUS_DOT[entry.task.status] : APPOINTMENT_STATUS_DOT[entry.appointment.status]
  const taskDone = isTask && entry.task.status === 'completada'
  const canActAppointment = !isTask && entry.appointment.status === 'activa' && !busy

  return (
    <div className={`flex items-center gap-1 rounded-lg border border-brand-100 bg-white transition-colors hover:border-accent-200 ${compact ? 'px-1.5 py-1' : 'px-3 py-2'}`}>
      {isTask ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleTask()
          }}
          disabled={busy}
          aria-label={taskDone ? t('tasks.aria.markPending') : t('tasks.aria.markCompleted')}
          className={`flex shrink-0 items-center justify-center rounded-full border transition-colors ${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} ${
            taskDone ? 'border-accent-500 bg-accent-500 text-white' : 'border-brand-300 text-transparent hover:border-accent-400'
          }`}
        >
          <CheckIcon width={compact ? 8 : 10} height={compact ? 8 : 10} />
        </button>
      ) : (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      )}
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span className={`shrink-0 font-semibold text-brand-800 ${compact ? 'text-[10px]' : 'text-xs'}`}>{time}</span>
        <span className={`truncate ${struckThrough || taskDone ? 'text-brand-400 line-through' : 'text-brand-700'} ${compact ? 'text-[10px]' : 'text-xs'}`}>{label}</span>
      </button>
      {canActAppointment && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onCompleteAppointment()
            }}
            aria-label={t('calendar.detail.markCompleted')}
            className="rounded p-1 text-emerald-600 hover:bg-emerald-50"
          >
            <CheckIcon width={compact ? 11 : 13} height={compact ? 11 : 13} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onCancelAppointment()
            }}
            aria-label={t('calendar.detail.cancelAppointment')}
            className="rounded p-1 text-red-500 hover:bg-red-50"
          >
            <XCircleIcon width={compact ? 11 : 13} height={compact ? 11 : 13} />
          </button>
        </div>
      )}
    </div>
  )
}
