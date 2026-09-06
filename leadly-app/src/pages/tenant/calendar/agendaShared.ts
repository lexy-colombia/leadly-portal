import type { TaskWithRelations } from '../../../lib/api/tasks'
import type { AppointmentStatus, AppointmentWithContact, TaskStatus } from '../../../types/domain'
import type { TranslationKey } from '../../../i18n/translations'

export type EntryType = 'appointment' | 'task'

export type CalendarEntry =
  | { kind: 'appointment'; time: number; appointment: AppointmentWithContact }
  | { kind: 'task'; time: number; task: TaskWithRelations }

/** Antes había 7 colores distintos repartidos en 4 mapas (uno por cada
 * combinación de tipo × estado) sin ninguna leyenda -- feedback directo del
 * usuario (2026-09-02): "no se como manejarlo ni como entenderlo". Ahora hay
 * un único lugar que decide el color, y el color codifica UNA sola cosa
 * (nunca dos a la vez): normalmente el TIPO (cita=celeste, tarea=violeta);
 * si está vencida, vencida gana y todo se pinta rojo sin importar el tipo;
 * completada/cancelada tienen su propio color fijo sin importar el tipo. */
export function entryVisual(type: EntryType, status: AppointmentStatus | TaskStatus, overdue: boolean): { dot: string; chip: string; label: TranslationKey } {
  if (status === 'cancelada') return { dot: 'bg-brand-300', chip: 'bg-brand-50 text-brand-400 hover:bg-brand-100 line-through', label: 'calendar.status.cancelada' }
  if (status === 'completada') return { dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100', label: 'calendar.status.completada' }
  if (overdue) return { dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 hover:bg-red-100', label: 'calendar.overdue' }
  return type === 'appointment'
    ? { dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 hover:bg-sky-100', label: 'calendar.type.appointment' }
    : { dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 hover:bg-violet-100', label: 'calendar.type.task' }
}

/** Badge classes for the "Estado" column of the list view / pending panel --
 * same semantics as entryVisual's chip, just shaped for shadcn's Badge
 * (`border-transparent bg-x text-y`) instead of a chip button. */
export function entryStatusBadgeClass(_type: EntryType, status: AppointmentStatus | TaskStatus, overdue: boolean): string {
  if (status === 'cancelada') return 'border-transparent bg-brand-100 text-brand-500 line-through'
  if (status === 'completada') return 'border-transparent bg-emerald-100 text-emerald-700'
  if (overdue) return 'border-transparent bg-red-100 text-red-700'
  return 'border-transparent bg-amber-100 text-amber-700'
}

/** Una cita/tarea sigue "abierta" (activa/pendiente/en_proceso) y su fecha ya
 * pasó -- Fase 2 de "oportunidades/tareas/citas transversal" (2026-09-02). */
export function isEntryOverdue(entry: CalendarEntry, nowMs: number): boolean {
  if (entry.kind === 'task') return (entry.task.status === 'pendiente' || entry.task.status === 'en_proceso') && entry.time < nowMs
  return entry.appointment.status === 'activa' && entry.time < nowMs
}

export function entryStatus(entry: CalendarEntry): AppointmentStatus | TaskStatus {
  return entry.kind === 'appointment' ? entry.appointment.status : entry.task.status
}

/** "Sigue pendiente de resolverse" -- activa (cita) o pendiente/en_proceso
 * (tarea) -- usado por el filtro "Abiertas" y la barra de progreso del día. */
export function isEntryOpen(entry: CalendarEntry): boolean {
  if (entry.kind === 'appointment') return entry.appointment.status === 'activa'
  return entry.task.status === 'pendiente' || entry.task.status === 'en_proceso'
}

export function entryId(entry: CalendarEntry): string {
  return entry.kind === 'appointment' ? entry.appointment.id : entry.task.id
}

export function entryAssignedTo(entry: CalendarEntry): string | null {
  return entry.kind === 'appointment' ? entry.appointment.assigned_to : entry.task.assigned_to
}

export function entryAssigneeName(entry: CalendarEntry): string | null {
  return entry.kind === 'appointment' ? entry.appointment.assignee_full_name : (entry.task.assignee?.full_name ?? null)
}

/** El nombre a mostrar como título de la entrada -- el contacto para una
 * cita, el título de la tarea para una tarea. */
export function entryLabel(entry: CalendarEntry): string {
  return entry.kind === 'appointment' ? (entry.appointment.contact_full_name ?? '—') : entry.task.title
}

/** "Cliente" de la fila de la vista Lista -- para una tarea es su contacto
 * vinculado si tiene uno (puede ser una tarea general, sin contacto). */
export function entryClientName(entry: CalendarEntry): string | null {
  return entry.kind === 'appointment' ? entry.appointment.contact_full_name : (entry.task.contact?.full_name ?? null)
}

/** Texto de búsqueda: todo lo que un usuario razonablemente tipearía para
 * encontrar esta fila (título/cliente/responsable). */
export function entrySearchText(entry: CalendarEntry): string {
  return [entryLabel(entry), entryClientName(entry), entryAssigneeName(entry)].filter(Boolean).join(' ').toLowerCase()
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

/** Monday-first: shifts Sunday (getDay()===0) to the end of the week. */
export function mondayOffset(d: Date): number {
  const weekday = d.getDay()
  return weekday === 0 ? 6 : weekday - 1
}

export function startOfGrid(monthStart: Date): Date {
  return addDays(monthStart, -mondayOffset(monthStart))
}

export function startOfWeek(d: Date): Date {
  return startOfDay(addDays(d, -mondayOffset(d)))
}

/** CSS `capitalize` uppercases every word ("agosto de 2026" -> "Agosto De
 * 2026", wrong in Spanish) -- this only uppercases the first letter, same as
 * how a human would title a date. */
export function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
