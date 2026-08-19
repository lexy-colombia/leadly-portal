import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { listAppointmentsForTenantRange } from '../../lib/api/appointments'
import type { AppointmentStatus, AppointmentWithContact } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { ChevronLeftIcon, PlusIcon } from '@/components/atoms/icons'
import { AppointmentFormDrawer } from './calendar/AppointmentFormDrawer'
import { AppointmentDetailDrawer } from './calendar/AppointmentDetailDrawer'

const WEEKDAY_KEYS: TranslationKey[] = [
  'calendar.weekday.mon',
  'calendar.weekday.tue',
  'calendar.weekday.wed',
  'calendar.weekday.thu',
  'calendar.weekday.fri',
  'calendar.weekday.sat',
  'calendar.weekday.sun',
]

const STATUS_DOT: Record<AppointmentStatus, string> = {
  activa: 'bg-amber-500',
  completada: 'bg-emerald-500',
  cancelada: 'bg-brand-300',
}

const STATUS_CHIP: Record<AppointmentStatus, string> = {
  activa: 'bg-amber-50 text-amber-700 hover:bg-amber-100',
  completada: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  cancelada: 'bg-brand-50 text-brand-400 hover:bg-brand-100 line-through',
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

/** Monday-first grid: shifts Sunday (getDay()===0) to the end of the week. */
function startOfGrid(monthStart: Date): Date {
  const weekday = monthStart.getDay()
  const offset = weekday === 0 ? 6 : weekday - 1
  return addDays(monthStart, -offset)
}

export function Calendar() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const tenantId = profile?.tenant_id ?? null

  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [appointments, setAppointments] = useState<AppointmentWithContact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formDrawer, setFormDrawer] = useState<{ open: boolean; prefillDate?: Date }>({ open: false })
  const [detailDrawer, setDetailDrawer] = useState<{ open: boolean; appointment: AppointmentWithContact | null }>({ open: false, appointment: null })

  const gridStart = useMemo(() => startOfGrid(month), [month])
  const nextMonthStart = useMemo(() => addMonths(month, 1), [month])
  const gridEnd = useMemo(() => startOfGrid(nextMonthStart), [nextMonthStart])
  const gridDays = useMemo(() => {
    const days: Date[] = []
    for (let d = gridStart; d < gridEnd; d = addDays(d, 1)) days.push(d)
    return days
  }, [gridStart, gridEnd])

  function reload() {
    if (!tenantId) return
    listAppointmentsForTenantRange(tenantId, gridStart.toISOString(), gridEnd.toISOString())
      .then(setAppointments)
      .catch((err) => setError(err.message ?? t('calendar.errors.loadFailed')))
  }

  useEffect(reload, [tenantId, gridStart, gridEnd])

  const appointmentsByDay = useMemo(() => {
    const map = new Map<string, AppointmentWithContact[]>()
    for (const appt of appointments ?? []) {
      const key = dateKey(new Date(appt.scheduled_at))
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(appt)
    }
    return map
  }, [appointments])

  function upsertAppointment(updated: AppointmentWithContact) {
    setAppointments((prev) => {
      if (!prev) return [updated]
      const exists = prev.some((a) => a.id === updated.id)
      return exists ? prev.map((a) => (a.id === updated.id ? updated : a)) : [...prev, updated]
    })
  }

  const today = new Date()
  const todayKey = dateKey(today)
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const monthLabel = month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })

  if (!tenantId) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold capitalize text-brand-800 sm:text-2xl">{monthLabel}</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => setMonth(addMonths(month, -1))} aria-label={t('calendar.aria.prevMonth')}>
            <ChevronLeftIcon width={16} height={16} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>
            {t('calendar.today')}
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => setMonth(addMonths(month, 1))} aria-label={t('calendar.aria.nextMonth')}>
            <ChevronLeftIcon width={16} height={16} className="rotate-180" />
          </Button>
          <Button size="sm" onClick={() => setFormDrawer({ open: true })}>
            <PlusIcon width={14} height={14} /> {t('calendar.actions.new')}
          </Button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <Card padded={false} className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-brand-100 bg-brand-50/50">
          {WEEKDAY_KEYS.map((key) => (
            <div key={key} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-brand-400">
              {t(key)}
            </div>
          ))}
        </div>

        {!appointments && <PageSpinner />}

        {appointments && (
          <div className="grid grid-cols-7">
            {gridDays.map((day) => {
              const key = dateKey(day)
              const isCurrentMonth = day.getMonth() === month.getMonth()
              const isToday = key === todayKey
              const dayAppointments = appointmentsByDay.get(key) ?? []
              const visible = dayAppointments.slice(0, 3)
              const overflow = dayAppointments.length - visible.length

              return (
                <div
                  key={key}
                  onClick={() => setFormDrawer({ open: true, prefillDate: day })}
                  className={`min-h-[100px] cursor-pointer border-b border-r border-brand-50 p-1.5 transition-colors last:border-r-0 hover:bg-accent-50/40 ${
                    isCurrentMonth ? 'bg-white' : 'bg-brand-50/40'
                  }`}
                >
                  <span
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                      isToday ? 'bg-accent-500 text-white' : isCurrentMonth ? 'text-brand-700' : 'text-brand-300'
                    }`}
                  >
                    {day.getDate()}
                  </span>
                  <div className="mt-1 space-y-1">
                    {visible.map((appt) => (
                      <button
                        key={appt.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDetailDrawer({ open: true, appointment: appt })
                        }}
                        className={`flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[10px] font-medium transition-colors ${STATUS_CHIP[appt.status]}`}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[appt.status]}`} />
                        <span className="truncate">
                          {new Date(appt.scheduled_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })} {appt.contact_full_name}
                        </span>
                      </button>
                    ))}
                    {overflow > 0 && <p className="px-1.5 text-[10px] text-brand-400">{t('calendar.moreCount', { count: overflow })}</p>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <AppointmentFormDrawer
        open={formDrawer.open}
        onClose={() => setFormDrawer({ open: false })}
        tenantId={tenantId}
        prefillDate={formDrawer.prefillDate}
        onCreated={upsertAppointment}
      />

      <AppointmentDetailDrawer
        open={detailDrawer.open}
        onClose={() => setDetailDrawer({ open: false, appointment: null })}
        appointment={detailDrawer.appointment}
        onChanged={upsertAppointment}
      />
    </div>
  )
}
