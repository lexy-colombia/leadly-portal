import { useState } from 'react'
import { Link } from 'react-router-dom'
import { updateAppointmentStatus } from '../../../lib/api/appointments'
import type { AppointmentStatus, AppointmentWithContact } from '../../../types/domain'
import { Badge, Button, Drawer } from '../../../components/ui'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { Language, TranslationKey } from '../../../i18n/translations'

const STATUS_KEY: Record<AppointmentStatus, TranslationKey> = {
  activa: 'calendar.status.activa',
  completada: 'calendar.status.completada',
  cancelada: 'calendar.status.cancelada',
}

const STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  activa: 'warning',
  completada: 'success',
  cancelada: 'danger',
}

function formatDateTime(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
}

export function AppointmentDetailDrawer({
  open,
  onClose,
  appointment,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  appointment: AppointmentWithContact | null
  onChanged: (appointment: AppointmentWithContact) => void
}) {
  const { t, language } = useLanguage()
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!appointment) return null

  async function handleStatus(status: AppointmentStatus) {
    if (!appointment) return
    setUpdating(true)
    setError(null)
    try {
      const updated = await updateAppointmentStatus(appointment.id, status)
      onChanged({ ...updated, contact_full_name: appointment.contact_full_name })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('calendar.errors.updateFailed'))
    } finally {
      setUpdating(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('calendar.detail.title')}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Link to={`/app/clientes/${appointment.contact_id}`} className="text-base font-semibold text-accent-600 hover:underline">
            {appointment.contact_full_name ?? t('calendar.detail.contactFallback')}
          </Link>
          <Badge tone={STATUS_TONE[appointment.status]}>{t(STATUS_KEY[appointment.status])}</Badge>
        </div>

        <p className="text-sm capitalize text-brand-700">{formatDateTime(appointment.scheduled_at, language)}</p>

        {appointment.notes && <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-600">{appointment.notes}</p>}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {appointment.status === 'activa' && (
          <div className="flex gap-2 border-t border-brand-100 pt-4">
            <Button variant="secondary" onClick={() => handleStatus('completada')} disabled={updating}>
              {updating ? t('common.actions.saving') : t('calendar.detail.markCompleted')}
            </Button>
            <Button variant="danger" onClick={() => handleStatus('cancelada')} disabled={updating}>
              {t('calendar.detail.cancelAppointment')}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  )
}
