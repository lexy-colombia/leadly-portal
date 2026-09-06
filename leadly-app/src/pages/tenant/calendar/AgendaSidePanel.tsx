import { useLanguage } from '../../../contexts/LanguageContext'
import { Card } from '@/components/molecules'
import { CheckIcon } from '@/components/atoms/icons'
import { CalendarEntryRow } from './CalendarEntryRow'
import { type CalendarEntry, capitalizeFirst, entryId, entryLabel, isEntryOpen, isEntryOverdue } from './agendaShared'

/** Ítem del checklist de "Pendientes del día" -- a diferencia de
 * CalendarEntryRow (que separa completar/cancelar en dos botones para una
 * cita), acá cita y tarea comparten un único checkbox: togglear una cita lo
 * más simple es completada<->activa, sin ofrecer "cancelar" desde este
 * panel. */
function ChecklistItem({
  entry,
  locale,
  nowMs,
  busy,
  onOpen,
  onToggle,
}: {
  entry: CalendarEntry
  locale: string
  nowMs: number
  busy: boolean
  onOpen: () => void
  onToggle: () => void
}) {
  const { t } = useLanguage()
  const overdue = isEntryOverdue(entry, nowMs)
  const done = entry.kind === 'task' ? entry.task.status === 'completada' : entry.appointment.status === 'completada'
  const time = new Date(entry.time).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })

  return (
    <div className="flex items-center gap-2 rounded-lg border border-brand-100 bg-white px-2.5 py-1.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        disabled={busy}
        aria-label={done ? t('tasks.aria.markPending') : t('tasks.aria.markCompleted')}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
          done ? 'border-emerald-500 bg-emerald-500 text-white' : `border-brand-300 text-transparent hover:border-accent-500 ${overdue ? '!border-red-400' : ''}`
        }`}
      >
        <CheckIcon width={8} height={8} />
      </button>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span className="shrink-0 text-[10px] font-semibold text-brand-800">{time}</span>
        <span className={`truncate text-[11px] ${done ? 'text-brand-400 line-through' : overdue ? 'text-red-700' : 'text-brand-700'}`}>{entryLabel(entry)}</span>
      </button>
    </div>
  )
}

/** Panel lateral de la Agenda -- dos modos:
 * - `day-agenda` (vista Mes): "Agenda del día" seleccionado + link a la
 *   vista Lista completa.
 * - `day-progress` (vista Día): "Pendientes del día" con barra de progreso
 *   (completadas/total) + checklist unificado cita/tarea. */
export function AgendaSidePanel({
  mode,
  day,
  entries,
  locale,
  nowMs,
  quickUpdating,
  onOpenEntry,
  onCompleteAppointment,
  onCancelAppointment,
  onToggleTask,
  onToggleAppointment,
  onViewAll,
}: {
  mode: 'day-agenda' | 'day-progress'
  day: Date
  entries: CalendarEntry[]
  locale: string
  nowMs: number
  quickUpdating: string | null
  onOpenEntry: (entry: CalendarEntry) => void
  onCompleteAppointment: (entry: CalendarEntry) => void
  onCancelAppointment: (entry: CalendarEntry) => void
  onToggleTask: (entry: CalendarEntry) => void
  onToggleAppointment: (entry: CalendarEntry) => void
  onViewAll?: () => void
}) {
  const { t } = useLanguage()
  const dayLabel = capitalizeFirst(day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' }))
  const pendingCount = entries.filter(isEntryOpen).length
  const doneCount = entries.length - pendingCount
  const progressPct = entries.length === 0 ? 0 : Math.round((doneCount / entries.length) * 100)

  return (
    <Card className="flex h-full flex-col gap-3">
      <div>
        <h2 className="text-xs font-bold text-brand-800">{t(mode === 'day-agenda' ? 'calendar.agenda.title' : 'calendar.pending.title')}</h2>
        <p className="mt-0.5 text-xs text-brand-500">{dayLabel}</p>
      </div>

      {mode === 'day-agenda' && (
        <p className="text-xs font-medium text-accent-600">{t('calendar.agenda.pendingCount', { count: pendingCount })}</p>
      )}

      {mode === 'day-progress' && (
        <div>
          <p className="text-[11px] text-brand-400">{t('calendar.pending.progress', { done: doneCount, total: entries.length })}</p>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-brand-50">
            <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {entries.length === 0 && <p className="py-6 text-center text-xs text-brand-400">{t('calendar.agenda.empty')}</p>}
        {mode === 'day-agenda' &&
          entries.map((entry) => (
            <CalendarEntryRow
              key={entryId(entry)}
              entry={entry}
              locale={locale}
              nowMs={nowMs}
              compact
              busy={quickUpdating === entryId(entry)}
              onOpen={() => onOpenEntry(entry)}
              onCompleteAppointment={() => onCompleteAppointment(entry)}
              onCancelAppointment={() => onCancelAppointment(entry)}
              onToggleTask={() => onToggleTask(entry)}
            />
          ))}
        {mode === 'day-progress' &&
          entries.map((entry) => (
            <ChecklistItem
              key={entryId(entry)}
              entry={entry}
              locale={locale}
              nowMs={nowMs}
              busy={quickUpdating === entryId(entry)}
              onOpen={() => onOpenEntry(entry)}
              onToggle={() => (entry.kind === 'task' ? onToggleTask(entry) : onToggleAppointment(entry))}
            />
          ))}
      </div>

      {mode === 'day-agenda' && onViewAll && (
        <button type="button" onClick={onViewAll} className="text-xs font-semibold text-accent-600 hover:underline">
          {t('calendar.agenda.viewAll')} →
        </button>
      )}
    </Card>
  )
}
