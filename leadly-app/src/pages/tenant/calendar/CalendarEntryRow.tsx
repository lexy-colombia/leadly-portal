import { useLanguage } from '../../../contexts/LanguageContext'
import { CalendarIcon, CheckIcon, XCircleIcon } from '@/components/atoms/icons'
import { type CalendarEntry, entryLabel, entryVisual, isEntryOverdue } from './agendaShared'

/** Fila unificada de cita o tarea con acciones rápidas (completar/cancelar
 * una cita, o tildar una tarea) sin tener que abrir ningún drawer -- usada
 * en las vistas semana (compact), día, y en el panel lateral de agenda. Los
 * botones siempre están visibles (no ocultos tras :hover) porque el panel es
 * mobile-first y el hover no existe en touch. */
export function CalendarEntryRow({
  entry,
  locale,
  nowMs,
  compact,
  busy,
  onOpen,
  onCompleteAppointment,
  onCancelAppointment,
  onToggleTask,
}: {
  entry: CalendarEntry
  locale: string
  nowMs: number
  compact?: boolean
  busy: boolean
  onOpen: () => void
  onCompleteAppointment: () => void
  onCancelAppointment: () => void
  onToggleTask: () => void
}) {
  const { t } = useLanguage()
  const isTask = entry.kind === 'task'
  const overdue = isEntryOverdue(entry, nowMs)
  const status = isTask ? entry.task.status : entry.appointment.status
  const { dot, label: typeLabelKey } = entryVisual(entry.kind, status, overdue)
  const time = new Date(entry.time).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  const label = entryLabel(entry)
  const struckThrough = status === 'cancelada'
  const taskDone = isTask && entry.task.status === 'completada'
  const canActAppointment = !isTask && entry.appointment.status === 'activa' && !busy
  const badgeSize = compact ? 'h-4 w-4' : 'h-5 w-5'
  const badgeIconSize = compact ? 8 : 10

  return (
    <div className={`flex items-center gap-1.5 rounded-lg border border-brand-100 bg-white transition-colors hover:border-accent-200 ${compact ? 'px-1.5 py-1' : 'px-3 py-2'}`}>
      {isTask ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleTask()
          }}
          disabled={busy}
          aria-label={taskDone ? t('tasks.aria.markPending') : t('tasks.aria.markCompleted')}
          className={`flex shrink-0 items-center justify-center rounded-full border-2 transition-colors ${badgeSize} ${
            taskDone ? 'border-emerald-500 bg-emerald-500 text-white' : `border-violet-300 text-transparent hover:border-violet-500 ${overdue ? '!border-red-400' : ''}`
          }`}
        >
          <CheckIcon width={badgeIconSize} height={badgeIconSize} />
        </button>
      ) : (
        <span className={`flex shrink-0 items-center justify-center rounded-full text-white ${badgeSize} ${dot}`} title={t(typeLabelKey)}>
          <CalendarIcon width={badgeIconSize} height={badgeIconSize} />
        </span>
      )}
      <button onClick={onOpen} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-left">
        <span className={`shrink-0 font-semibold text-brand-800 ${compact ? 'text-[10px]' : 'text-xs'}`}>{time}</span>
        {!compact && (
          <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${isTask ? 'bg-violet-50 text-violet-600' : 'bg-sky-50 text-sky-600'}`}>
            {t(isTask ? 'calendar.type.task' : 'calendar.type.appointment')}
          </span>
        )}
        <span className={`truncate ${struckThrough || taskDone ? 'text-brand-400 line-through' : overdue ? 'text-red-700' : 'text-brand-700'} ${compact ? 'text-[10px]' : 'text-xs'}`}>
          {label}
        </span>
        {overdue && (
          <span className={`shrink-0 rounded bg-red-50 px-1 font-semibold text-red-600 ${compact ? 'text-[8px]' : 'text-[9px]'}`}>{t('calendar.overdue')}</span>
        )}
      </button>
      {canActAppointment && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onCompleteAppointment()
            }}
            aria-label={t('calendar.detail.markCompleted')}
            className="rounded-md border border-emerald-200 bg-emerald-50 p-1 text-emerald-700 hover:bg-emerald-100"
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
            className="rounded-md border border-red-200 bg-red-50 p-1 text-red-600 hover:bg-red-100"
          >
            <XCircleIcon width={compact ? 11 : 13} height={compact ? 11 : 13} />
          </button>
        </div>
      )}
    </div>
  )
}
