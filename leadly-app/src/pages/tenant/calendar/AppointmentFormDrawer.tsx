import { useEffect, useState, type FormEvent } from 'react'
import { createAppointment } from '../../../lib/api/appointments'
import { listContacts } from '../../../lib/api/contacts'
import type { AppointmentWithContact, Client } from '../../../types/domain'
import { Button, FieldError, Input, Label, Textarea } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { SearchIcon } from '@/components/atoms/icons'
import { useLanguage } from '../../../contexts/LanguageContext'

function defaultDateTime(prefill?: Date): string {
  const d = prefill ? new Date(prefill) : new Date(Date.now() + 60 * 60 * 1000)
  if (!prefill) d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function AppointmentFormDrawer({
  open,
  onClose,
  tenantId,
  prefillDate,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Pre-fills the date when opened from an empty calendar cell. */
  prefillDate?: Date
  onCreated: (appointment: AppointmentWithContact) => void
}) {
  const { t } = useLanguage()
  const [contacts, setContacts] = useState<Client[] | null>(null)
  const [contactQuery, setContactQuery] = useState('')
  const [selectedContact, setSelectedContact] = useState<Client | null>(null)
  const [dateTime, setDateTime] = useState(defaultDateTime())
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDateTime(defaultDateTime(prefillDate))
    setNotes('')
    setContactQuery('')
    setSelectedContact(null)
    setTouched(false)
    setFormError(null)
    listContacts(tenantId).then(setContacts).catch(() => setContacts([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId, prefillDate])

  const dateError = touched && !dateTime ? t('calendar.form.dateRequired') : undefined
  const contactError = touched && !selectedContact ? t('calendar.form.contactRequired') : undefined
  const isPast = dateTime && new Date(dateTime).getTime() < Date.now()

  const matches =
    contactQuery.trim() && !selectedContact
      ? (contacts ?? [])
          .filter((c) => c.full_name.toLowerCase().includes(contactQuery.trim().toLowerCase()) || c.phone.includes(contactQuery.trim()))
          .slice(0, 8)
      : []

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!dateTime || !selectedContact) return

    setSubmitting(true)
    try {
      const appointment = await createAppointment(tenantId, selectedContact.id, new Date(dateTime).toISOString(), notes.trim())
      onCreated({ ...appointment, contact_full_name: selectedContact.full_name })
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('calendar.errors.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('calendar.form.title')} description={t('calendar.form.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="appt-contact">{t('calendar.form.contact')}</Label>
          {selectedContact ? (
            <div className="flex items-center justify-between rounded-xl border border-brand-200 px-3.5 py-2.5 text-sm">
              <span className="font-medium text-brand-800">{selectedContact.full_name}</span>
              <button type="button" onClick={() => setSelectedContact(null)} className="text-xs font-medium text-accent-600 hover:underline">
                {t('calendar.form.change')}
              </button>
            </div>
          ) : (
            <div className="relative">
              <Input
                id="appt-contact"
                value={contactQuery}
                invalid={!!contactError}
                onChange={(e) => setContactQuery(e.target.value)}
                placeholder={t('calendar.form.searchPlaceholder')}
                autoComplete="off"
              />
              {matches.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-xl border border-brand-100 bg-white py-1 shadow-lg">
                  {matches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelectedContact(c)
                        setContactQuery('')
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50"
                    >
                      <SearchIcon width={13} height={13} className="text-brand-300" />
                      <span className="font-medium text-brand-800">{c.full_name}</span>
                      <span className="text-xs text-brand-400">{c.phone}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <FieldError message={contactError} />
        </div>

        <div>
          <Label htmlFor="appt-datetime">{t('calendar.form.dateTime')}</Label>
          <Input id="appt-datetime" type="datetime-local" value={dateTime} invalid={!!dateError} onChange={(e) => setDateTime(e.target.value)} />
          <FieldError message={dateError} />
          {!dateError && isPast && <p className="mt-1 text-xs text-amber-600">{t('calendar.form.pastWarning')}</p>}
        </div>

        <div>
          <Label htmlFor="appt-notes">{t('calendar.form.notes')}</Label>
          <Textarea id="appt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('calendar.form.notesPlaceholder')} rows={3} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? t('calendar.form.submitting') : t('calendar.form.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
