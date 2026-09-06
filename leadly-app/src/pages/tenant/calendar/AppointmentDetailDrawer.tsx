import { useState } from 'react'
import { Link } from 'react-router-dom'
import { updateAppointmentStatus } from '../../../lib/api/appointments'
import type { AppointmentStatus, AppointmentWithContact } from '../../../types/domain'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDateTime } from '../../../lib/dates'
import { useOpportunityStageGate } from '../../../lib/useOpportunityStageGate'

const STATUS_KEY: Record<AppointmentStatus, TranslationKey> = {
  activa: 'calendar.status.activa',
  completada: 'calendar.status.completada',
  cancelada: 'calendar.status.cancelada',
}

const STATUS_BADGE_CLASS: Record<AppointmentStatus, string> = {
  activa: 'border-transparent bg-amber-100 text-amber-700',
  completada: 'border-transparent bg-emerald-100 text-emerald-700',
  cancelada: 'border-transparent bg-red-100 text-red-700',
}

export function AppointmentDetailDrawer({
  open,
  onClose,
  appointment,
  onChanged,
  onReschedule,
}: {
  open: boolean
  onClose: () => void
  appointment: AppointmentWithContact | null
  onChanged: (appointment: AppointmentWithContact) => void
  onReschedule: (appointment: AppointmentWithContact) => void
}) {
  const { t, language } = useLanguage()
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { requestStageDecision, dialog: stageGateDialog } = useOpportunityStageGate()

  if (!appointment) return null

  async function doSetStatus(status: AppointmentStatus) {
    if (!appointment) return
    setUpdating(true)
    setError(null)
    try {
      const updated = await updateAppointmentStatus(appointment.id, status)
      onChanged({ ...updated, contact_full_name: appointment.contact_full_name, assignee_full_name: appointment.assignee_full_name, opportunity_title: appointment.opportunity_title })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('calendar.errors.updateFailed'))
    } finally {
      setUpdating(false)
    }
  }

  // Completar una cita con oportunidad vinculada exige decidir antes qué pasa
  // con esa oportunidad (pedido explícito del usuario, 2026-09-06) --
  // cancelar no pasa por el gate, solo "completada".
  function handleStatus(status: AppointmentStatus) {
    if (status === 'completada' && appointment?.opportunity_id) {
      requestStageDecision(appointment.opportunity_id, appointment.contact_full_name ?? t('calendar.detail.contactFallback'), () => doSetStatus(status))
      return
    }
    doSetStatus(status)
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('calendar.detail.title')}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Link to={`/app/clients/${appointment.contact_id}`} className="text-xs font-semibold text-accent-600 hover:underline">
            {appointment.contact_full_name ?? t('calendar.detail.contactFallback')}
          </Link>
          <Badge variant="outline" className={STATUS_BADGE_CLASS[appointment.status]}>
            {t(STATUS_KEY[appointment.status])}
          </Badge>
        </div>

        <p className="text-xs text-brand-700">
          {formatDateTime(appointment.scheduled_at, language)} – {new Date(appointment.ends_at).toLocaleTimeString(language === 'en' ? 'en-US' : 'es-CO', { hour: 'numeric', minute: '2-digit' })}
        </p>

        {appointment.assignee_full_name && (
          <p className="text-xs text-brand-500">
            {t('calendar.filters.owner.label')}: <span className="font-medium text-brand-700">{appointment.assignee_full_name}</span>
          </p>
        )}

        {appointment.opportunity_id && (
          <Link to={`/app/opportunities?opportunity=${appointment.opportunity_id}`} className="block text-xs font-semibold text-accent-600 hover:underline">
            {t('calendar.detail.opportunity')}: {appointment.opportunity_title ?? t('calendar.detail.opportunity')}
          </Link>
        )}

        {appointment.notes && <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-600">{appointment.notes}</p>}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        {appointment.status === 'activa' && (
          <div className="flex flex-wrap gap-2 border-t border-brand-100 pt-4">
            <Button onClick={() => handleStatus('completada')} disabled={updating}>
              {updating ? t('common.actions.saving') : t('calendar.detail.markCompleted')}
            </Button>
            <Button variant="outline" onClick={() => onReschedule(appointment)} disabled={updating}>
              {t('calendar.detail.reschedule')}
            </Button>
            <Button variant="destructive" onClick={() => handleStatus('cancelada')} disabled={updating}>
              {t('calendar.detail.cancelAppointment')}
            </Button>
          </div>
        )}
      </div>
      {stageGateDialog}
    </Drawer>
  )
}
