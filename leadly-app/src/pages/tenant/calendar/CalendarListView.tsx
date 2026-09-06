import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { EmptyState } from '@/components/molecules'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  type CalendarEntry,
  addDays,
  capitalizeFirst,
  dateKey,
  entryAssigneeName,
  entryClientName,
  entryId,
  entryLabel,
  entryOpportunity,
  entryStatus,
  entryStatusBadgeClass,
  isEntryOverdue,
  startOfDay,
} from './agendaShared'

const RANGE_OPTIONS = [7, 14, 30, 90] as const
const RANGE_LABEL_KEY: Record<(typeof RANGE_OPTIONS)[number], TranslationKey> = {
  7: 'calendar.list.range.7',
  14: 'calendar.list.range.14',
  30: 'calendar.list.range.30',
  90: 'calendar.list.range.90',
}
/** El estado real usa namespaces distintos por tipo (`calendar.status.*` para
 * citas: activa/completada/cancelada; `tasks.status.*` para tareas, que
 * además distinguen pendiente/en_proceso) -- no hay un mapa plano único por
 * `status` porque el mismo string no siempre significa lo mismo entre los
 * dos tipos. */
function statusLabelKey(entry: CalendarEntry): TranslationKey {
  if (entry.kind === 'appointment') {
    return entry.appointment.status === 'activa' ? 'calendar.status.activa' : entry.appointment.status === 'completada' ? 'calendar.status.completada' : 'calendar.status.cancelada'
  }
  switch (entry.task.status) {
    case 'pendiente':
      return 'tasks.status.pendiente'
    case 'en_proceso':
      return 'tasks.status.en_proceso'
    case 'completada':
      return 'tasks.status.completada'
    default:
      return 'tasks.status.cancelada'
  }
}

/** Vista Lista -- reemplaza la grilla por una tabla agrupada por fecha
 * dentro de un rango ancho ("Próximos N días", en vez del mes/semana/día
 * puntual de las otras 3 vistas) -- mismo patrón de Table que
 * `OpportunityListView.tsx`, con una fila divisoria de fecha (colSpan) entre
 * grupos en vez de una tabla por día. */
export function CalendarListView({
  rangeStart,
  entriesByDay,
  rangeDays,
  onRangeDaysChange,
  locale,
  nowMs,
  todayKey,
  onOpenEntry,
}: {
  rangeStart: Date
  entriesByDay: Map<string, CalendarEntry[]>
  rangeDays: number
  onRangeDaysChange: (days: number) => void
  locale: string
  nowMs: number
  todayKey: string
  onOpenEntry: (entry: CalendarEntry) => void
}) {
  const { t } = useLanguage()

  const groups: { key: string; date: Date; entries: CalendarEntry[] }[] = []
  for (let d = startOfDay(rangeStart), i = 0; i < rangeDays; d = addDays(d, 1), i++) {
    const key = dateKey(d)
    const entries = entriesByDay.get(key)
    if (entries && entries.length > 0) groups.push({ key, date: d, entries })
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Select value={String(rangeDays)} onValueChange={(v) => onRangeDaysChange(Number(v))}>
          <SelectTrigger className="!h-7 w-auto !rounded-lg !text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((days) => (
              <SelectItem key={days} value={String(days)} className="text-xs">
                {t(RANGE_LABEL_KEY[days])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {groups.length === 0 && <EmptyState>{t('calendar.list.empty')}</EmptyState>}

      {groups.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('calendar.list.columns.time')}</TableHead>
                <TableHead>{t('calendar.list.columns.activity')}</TableHead>
                <TableHead>{t('calendar.list.columns.type')}</TableHead>
                <TableHead>{t('calendar.list.columns.client')}</TableHead>
                <TableHead>{t('calendar.list.columns.assignee')}</TableHead>
                <TableHead>{t('calendar.list.columns.opportunity')}</TableHead>
                <TableHead>{t('calendar.list.columns.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-brand-50/70 hover:bg-brand-50/70">
                    <TableCell colSpan={7} className="text-xs font-semibold text-brand-700">
                      {group.key === todayKey ? `${t('calendar.list.today')} · ` : ''}
                      {capitalizeFirst(group.date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}
                    </TableCell>
                  </TableRow>
                  {group.entries.map((entry) => {
                    const overdue = isEntryOverdue(entry, nowMs)
                    const status = entryStatus(entry)
                    const statusLabel = overdue ? t('calendar.overdue') : t(statusLabelKey(entry))
                    const opportunity = entryOpportunity(entry)
                    const startLabel = new Date(entry.time).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
                    const endLabel =
                      entry.kind === 'appointment' ? new Date(entry.appointment.ends_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : null
                    return (
                      <TableRow key={entryId(entry)} className="cursor-pointer" onClick={() => onOpenEntry(entry)}>
                        <TableCell className="text-xs font-medium text-brand-800">{endLabel ? `${startLabel} – ${endLabel}` : startLabel}</TableCell>
                        <TableCell className="text-xs text-brand-700">{entryLabel(entry)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={entry.kind === 'task' ? 'border-transparent bg-violet-50 text-violet-600' : 'border-transparent bg-sky-50 text-sky-600'}>
                            {t(entry.kind === 'task' ? 'calendar.type.task' : 'calendar.type.appointment')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-brand-500">{entryClientName(entry) ?? '—'}</TableCell>
                        <TableCell className="text-xs text-brand-500">{entryAssigneeName(entry) ?? t('calendar.list.unassigned')}</TableCell>
                        <TableCell className="text-xs" onClick={(e) => opportunity && e.stopPropagation()}>
                          {opportunity ? (
                            <Link to={`/app/opportunities?opportunity=${opportunity.id}`} className="font-medium text-accent-600 hover:underline">
                              {opportunity.title}
                            </Link>
                          ) : (
                            <span className="text-brand-400">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={entryStatusBadgeClass(entry.kind, status, overdue)}>
                            {statusLabel}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
