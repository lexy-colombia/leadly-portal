import { useEffect, useState, type FormEvent } from 'react'
import { createAppointment, updateAppointment } from '../../../lib/api/appointments'
import { listClients } from '../../../lib/api/clients'
import type { AppointmentWithContact, Client } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useLanguage } from '../../../contexts/LanguageContext'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'

function defaultDateTime(prefill?: Date): string {
  const d = prefill ? new Date(prefill) : new Date(Date.now() + 60 * 60 * 1000)
  if (!prefill) d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface AppointmentEditInitial {
  id: string
  contactId: string
  dateTime: string
  notes: string
}

export function AppointmentFormDrawer({
  open,
  onClose,
  tenantId,
  prefillDate,
  editing,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Pre-fills the date when opened from an empty calendar cell. Ignored in edit mode. */
  prefillDate?: Date
  /** Present -> the drawer edits/reschedules this appointment instead of creating a new one. */
  editing?: AppointmentEditInitial | null
  onSaved: (appointment: AppointmentWithContact) => void
}) {
  const { t } = useLanguage()
  const isEdit = !!editing
  const [contacts, setContacts] = useState<Client[]>([])
  const [contactId, setContactId] = useState<string | null>(null)
  const [dateTime, setDateTime] = useState(defaultDateTime())
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDateTime(editing ? editing.dateTime : defaultDateTime(prefillDate))
    setNotes(editing?.notes ?? '')
    setContactId(editing?.contactId ?? null)
    setTouched(false)
    setFormError(null)
    listClients(tenantId).then(setContacts).catch(() => setContacts([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId, prefillDate, editing])

  const dateError = touched && !dateTime ? t('calendar.form.dateRequired') : undefined
  const contactError = touched && !contactId ? t('calendar.form.contactRequired') : undefined
  const isPast = dateTime && new Date(dateTime).getTime() < Date.now()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    const selectedContact = contacts.find((c) => c.id === contactId)
    if (!dateTime || !selectedContact) return

    setSubmitting(true)
    try {
      const appointment = editing
        ? await updateAppointment(editing.id, { contactId: selectedContact.id, scheduledAt: new Date(dateTime).toISOString(), notes: notes.trim() })
        : await createAppointment(tenantId, selectedContact.id, new Date(dateTime).toISOString(), notes.trim())
      onSaved({ ...appointment, contact_full_name: selectedContact.full_name })
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t(isEdit ? 'calendar.errors.updateFailed' : 'calendar.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t(isEdit ? 'calendar.form.editTitle' : 'calendar.form.title')} description={t(isEdit ? 'calendar.form.editDescription' : 'calendar.form.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label>{t('calendar.form.contact')}</Label>
          <div className="mt-1">
            <ComboboxFilter
              options={contacts.map((c) => ({ id: c.id, label: `${c.full_name} · ${c.phone}` }))}
              value={contactId}
              onChange={setContactId}
              placeholder={t('calendar.form.searchPlaceholder')}
              searchPlaceholder={t('calendar.form.searchPlaceholder')}
              emptyLabel={t('tasks.filter.noResults')}
              className="w-full"
              triggerClassName="w-full !rounded-lg"
            />
          </div>
          <FieldError message={contactError} />
        </div>

        <div>
          <Label htmlFor="appt-datetime">{t('calendar.form.dateTime')}</Label>
          <Input id="appt-datetime" type="datetime-local" value={dateTime} aria-invalid={!!dateError} onChange={(e) => setDateTime(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          <FieldError message={dateError} />
          {!dateError && isPast && <p className="mt-1 text-xs text-amber-600">{t('calendar.form.pastWarning')}</p>}
        </div>

        <div>
          <Label htmlFor="appt-notes">{t('calendar.form.notes')}</Label>
          <Textarea id="appt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('calendar.form.notesPlaceholder')} rows={2} className={`mt-1 ${TEXTAREA_CLASS}`} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? t(isEdit ? 'common.actions.saving' : 'calendar.form.submitting') : t(isEdit ? 'common.actions.saveChanges' : 'calendar.form.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
