import { useEffect, useState, type FormEvent } from 'react'
import { createAppointment } from '../../../lib/api/appointments'
import type { Appointment } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

function defaultDateTime(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function AppointmentDrawer({
  open,
  onClose,
  tenantId,
  contactId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  contactId: string
  onCreated: (appointment: Appointment) => void
}) {
  const { t } = useLanguage()
  const [dateTime, setDateTime] = useState(defaultDateTime())
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDateTime(defaultDateTime())
    setNotes('')
    setTouched(false)
    setFormError(null)
  }, [open])

  const dateError = touched && !dateTime ? t('contacts.appointmentDrawer.errors.dateRequired') : undefined
  const isPast = dateTime && new Date(dateTime).getTime() < Date.now()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!dateTime) return

    setSubmitting(true)
    try {
      const appointment = await createAppointment(tenantId, contactId, new Date(dateTime).toISOString(), notes.trim())
      onCreated(appointment)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('contacts.appointmentDrawer.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('contacts.appointmentDrawer.title')} description={t('contacts.appointmentDrawer.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="appt-datetime">{t('contacts.appointmentDrawer.fields.dateTime')}</Label>
          <Input id="appt-datetime" type="datetime-local" value={dateTime} aria-invalid={!!dateError} onChange={(e) => setDateTime(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          <FieldError message={dateError} />
          {!dateError && isPast && <p className="mt-1 text-xs text-amber-600">{t('contacts.appointmentDrawer.pastWarning')}</p>}
        </div>

        <div>
          <Label htmlFor="appt-notes">{t('contacts.appointmentDrawer.fields.notes')}</Label>
          <Textarea
            id="appt-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('contacts.appointmentDrawer.fields.notesPlaceholder')}
            rows={2}
            className={`mt-1 ${TEXTAREA_CLASS}`}
          />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('contacts.appointmentDrawer.submitting') : t('contacts.appointmentDrawer.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
