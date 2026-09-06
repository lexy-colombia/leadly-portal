import { useEffect, useRef, type MouseEvent } from 'react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { CalendarIcon, CheckIcon } from '@/components/atoms/icons'
import { type CalendarEntry, dateKey, entryEndMs, entryLabel, entryVisual, isEntryOverdue } from './agendaShared'

const START_HOUR = 6
const END_HOUR = 22
const HOUR_HEIGHT = 56
const GRID_HEIGHT = (END_HOUR - START_HOUR) * HOUR_HEIGHT
/** Piso de alto de un bloque para que uno muy corto (una tarea, o una cita
 * de 15 min) siga siendo legible/clickeable. */
const MIN_BLOCK_HEIGHT = 22

interface LaidOutEntry {
  entry: CalendarEntry
  col: number
  cols: number
}

/** Agrupa las entradas de un día en "clusters" de solapamiento continuo y
 * les asigna columna dentro del cluster (estilo Google Calendar simplificado)
 * -- no es interval-graph-coloring exacto, pero da un resultado razonable
 * para la cantidad de citas/tareas por día que maneja este producto. */
function layoutDayEntries(entries: CalendarEntry[]): LaidOutEntry[] {
  const sorted = [...entries].sort((a, b) => a.time - b.time)
  const withEnd = sorted.map((entry) => ({ entry, start: entry.time, end: entryEndMs(entry) }))
  const result: LaidOutEntry[] = []
  let cluster: typeof withEnd = []
  let clusterMaxEnd = -Infinity

  function flushCluster() {
    if (cluster.length === 0) return
    const columnEnds: number[] = []
    for (const item of cluster) {
      let placed = false
      for (let i = 0; i < columnEnds.length; i++) {
        if (columnEnds[i] <= item.start) {
          columnEnds[i] = item.end
          result.push({ entry: item.entry, col: i, cols: 0 })
          placed = true
          break
        }
      }
      if (!placed) {
        columnEnds.push(item.end)
        result.push({ entry: item.entry, col: columnEnds.length - 1, cols: 0 })
      }
    }
    const cols = columnEnds.length
    for (let i = result.length - cluster.length; i < result.length; i++) result[i].cols = cols
    cluster = []
    clusterMaxEnd = -Infinity
  }

  for (const item of withEnd) {
    if (cluster.length > 0 && item.start >= clusterMaxEnd) flushCluster()
    cluster.push(item)
    clusterMaxEnd = Math.max(clusterMaxEnd, item.end)
  }
  flushCluster()
  return result
}

function hourOffset(d: Date): number {
  return d.getHours() + d.getMinutes() / 60
}

function EventBlock({ laid, locale, onOpen }: { laid: LaidOutEntry; locale: string; onOpen: () => void }) {
  const { t } = useLanguage()
  const { entry, col, cols } = laid
  const overdue = isEntryOverdue(entry, Date.now())
  const status = entry.kind === 'appointment' ? entry.appointment.status : entry.task.status
  const { chip } = entryVisual(entry.kind, status, overdue)
  const start = new Date(entry.time)
  const durationMs = entryEndMs(entry) - entry.time
  const top = (hourOffset(start) - START_HOUR) * HOUR_HEIGHT
  const height = Math.max((durationMs / 3_600_000) * HOUR_HEIGHT, MIN_BLOCK_HEIGHT)
  const width = 100 / cols
  const left = col * width
  const time = start.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      style={{ top, height, width: `calc(${width}% - 3px)`, left: `${left}%` }}
      className={`absolute overflow-hidden rounded-md px-1.5 py-1 text-left text-[10px] font-medium shadow-sm transition-colors ${chip}`}
    >
      <span className="flex items-center gap-1 truncate font-semibold">
        {entry.kind === 'task' ? <CheckIcon width={8} height={8} className="shrink-0" /> : <CalendarIcon width={8} height={8} className="shrink-0" />}
        {time}
      </span>
      <span className="block truncate">{entryLabel(entry)}</span>
      {overdue && <span className="block truncate text-[9px] font-semibold">{t('calendar.overdue')}</span>}
    </button>
  )
}

/** Grilla horaria compartida por las vistas Semana (7 columnas) y Día (1
 * columna) -- eje de horas a la izquierda, línea roja de "ahora", bloques
 * posicionados por hora con manejo simple de solapamiento. Click en un
 * espacio vacío de una columna abre el drawer de crear cita prefilled con
 * ese día+hora; click en un bloque abre su detalle. */
export function TimeGrid({
  days,
  entriesByDay,
  locale,
  todayKey,
  onSlotClick,
  onEntryClick,
}: {
  days: Date[]
  entriesByDay: Map<string, CalendarEntry[]>
  locale: string
  todayKey: string
  onSlotClick: (day: Date, hour: number, minute: number) => void
  onEntryClick: (entry: CalendarEntry) => void
}) {
  const { t } = useLanguage()
  const scrollRef = useRef<HTMLDivElement>(null)
  const showDayHeaders = days.length > 1

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: Math.max((7 - START_HOUR) * HOUR_HEIGHT - HOUR_HEIGHT, 0) })
  }, [])

  const now = new Date()
  const nowTop = (hourOffset(now) - START_HOUR) * HOUR_HEIGHT

  function handleColumnClick(day: Date, e: MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const offsetY = e.clientY - rect.top
    const rawHour = START_HOUR + offsetY / HOUR_HEIGHT
    const hour = Math.floor(rawHour)
    const minute = rawHour - hour >= 0.5 ? 30 : 0
    onSlotClick(day, hour, minute)
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
      {showDayHeaders && (
        <div className="flex border-b border-brand-100">
          <div className="w-14 shrink-0" />
          <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
            {days.map((d) => {
              const isToday = dateKey(d) === todayKey
              return (
                <div key={dateKey(d)} className={`border-l border-brand-50 px-1 py-2 text-center first:border-l-0 ${isToday ? 'bg-accent-50' : ''}`}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-400">{d.toLocaleDateString(locale, { weekday: 'short' })}</p>
                  <span className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${isToday ? 'bg-accent-500 text-white' : 'text-brand-700'}`}>
                    {d.getDate()}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex overflow-y-auto" style={{ maxHeight: 560 }}>
        <div className="w-14 shrink-0 border-r border-brand-50" style={{ height: GRID_HEIGHT }}>
          {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i).map((hour) => (
            <div key={hour} className="relative" style={{ height: HOUR_HEIGHT }}>
              <span className="absolute -top-1.5 right-1.5 text-[10px] text-brand-400">
                {new Date(2000, 0, 1, hour).toLocaleTimeString(locale, { hour: 'numeric' })}
              </span>
            </div>
          ))}
        </div>

        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)`, height: GRID_HEIGHT }}>
          {days.map((d) => {
            const key = dateKey(d)
            const isToday = key === todayKey
            const laidOut = layoutDayEntries(entriesByDay.get(key) ?? [])
            return (
              <div
                key={key}
                onClick={(e) => handleColumnClick(d, e)}
                className={`relative cursor-pointer border-l border-brand-50 first:border-l-0 ${isToday ? 'bg-accent-50/20' : ''}`}
              >
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => i).map((i) => (
                  <div key={i} className="border-t border-brand-50 first:border-t-0" style={{ height: HOUR_HEIGHT }} />
                ))}
                {isToday && nowTop >= 0 && nowTop <= GRID_HEIGHT && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center gap-1" style={{ top: nowTop }}>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                    <span className="h-px flex-1 bg-red-500" />
                    <span className="shrink-0 rounded bg-red-500 px-1 text-[9px] font-semibold text-white">
                      {now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                )}
                {laidOut.map((laid) => (
                  <EventBlock key={laid.entry.kind === 'appointment' ? laid.entry.appointment.id : laid.entry.task.id} laid={laid} locale={locale} onOpen={() => onEntryClick(laid.entry)} />
                ))}
                {laidOut.length === 0 && !isToday && <span className="sr-only">{t('calendar.day.empty')}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
