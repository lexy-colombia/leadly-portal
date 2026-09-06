import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../../contexts/AuthContext'
import { createAppointment, updateAppointment } from '../../../lib/api/appointments'
import { listClients } from '../../../lib/api/clients'
import { listOpportunitiesForContact, type OpportunityWithRelations } from '../../../lib/api/opportunities'
import { listProfilesByTenant } from '../../../lib/api/users'
import { formatClientPhoneDisplay } from '../../../lib/phone'
import type { AppointmentWithContact, Client, Profile } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'
import { dateKey, formatDuration } from './agendaShared'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120]
const DEFAULT_DURATION_MINUTES = 30

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toTimeInputValue(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function defaultStart(prefill?: Date): Date {
  const d = prefill ? new Date(prefill) : new Date(Date.now() + 60 * 60 * 1000)
  if (!prefill) d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0)
  return d
}

export interface AppointmentEditInitial {
  id: string
  contactId: string
  /** Instante de inicio real (ISO), no un valor de <input type="datetime-local"> -- se
   * deriva la fecha/hora del formulario a partir de esto. */
  scheduledAt: string
  endsAt: string
  notes: string
  assignedTo: string | null
  opportunityId: string | null
  /** No editable directamente en este form -- threaded through purely so
   * onSaved can round-trip AppointmentWithContact sin perder el nombre que
   * la lista/detalle ya tenían (se recalcula solo si el usuario cambia la
   * oportunidad, ver `opportunities.find(...)` en handleSubmit). */
  assigneeFullName: string | null
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
  const { profile } = useAuth()
  const { t } = useLanguage()
  const isEdit = !!editing
  const [contacts, setContacts] = useState<Client[]>([])
  const [contactId, setContactId] = useState<string | null>(null)
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_DURATION_MINUTES)
  const [agents, setAgents] = useState<Profile[]>([])
  const [assignedTo, setAssignedTo] = useState<string | null>(null)
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[]>([])
  const [opportunityId, setOpportunityId] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const start = editing ? new Date(editing.scheduledAt) : defaultStart(prefillDate)
    setDate(dateKey(start))
    setStartTime(toTimeInputValue(start))
    setDurationMinutes(editing ? Math.max(5, Math.round((new Date(editing.endsAt).getTime() - start.getTime()) / 60000)) : DEFAULT_DURATION_MINUTES)
    setNotes(editing?.notes ?? '')
    setContactId(editing?.contactId ?? null)
    setOpportunityId(editing?.opportunityId ?? null)
    setAssignedTo(editing?.assignedTo ?? profile?.id ?? null)
    setTouched(false)
    setFormError(null)
    listClients(tenantId).then(setContacts).catch(() => setContacts([]))
    listProfilesByTenant(tenantId).then(setAgents).catch(() => setAgents([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId, prefillDate, editing])

  // Las oportunidades vinculables son las del contacto elegido -- se
  // recargan cuando cambia. Al abrir en modo edición, `contactId` ya viene
  // seteado desde el efecto de arriba, así que esto también corre y trae la
  // oportunidad ya vinculada sin pasos extra.
  useEffect(() => {
    if (!open || !contactId) {
      setOpportunities([])
      return
    }
    listOpportunitiesForContact(contactId).then(setOpportunities).catch(() => setOpportunities([]))
  }, [open, contactId])

  function handleContactChange(id: string | null) {
    setContactId(id)
    setOpportunityId(null)
  }

  const dateError = touched && (!date || !startTime) ? t('calendar.form.dateRequired') : undefined
  const contactError = touched && !contactId ? t('calendar.form.contactRequired') : undefined
  const durationOptions = DURATION_OPTIONS.includes(durationMinutes) ? DURATION_OPTIONS : [...DURATION_OPTIONS, durationMinutes].sort((a, b) => a - b)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    const selectedContact = contacts.find((c) => c.id === contactId)
    if (!date || !startTime || !selectedContact) return

    const scheduledAt = new Date(`${date}T${startTime}`)
    const endsAt = new Date(scheduledAt.getTime() + durationMinutes * 60000)

    setSubmitting(true)
    try {
      const appointment = editing
        ? await updateAppointment(editing.id, {
            contactId: selectedContact.id,
            scheduledAt: scheduledAt.toISOString(),
            endsAt: endsAt.toISOString(),
            notes: notes.trim(),
            assignedTo,
            opportunityId,
          })
        : await createAppointment(tenantId, selectedContact.id, scheduledAt.toISOString(), endsAt.toISOString(), notes.trim(), assignedTo, opportunityId)
      onSaved({
        ...appointment,
        contact_full_name: selectedContact.full_name,
        assignee_full_name: agents.find((a) => a.id === assignedTo)?.full_name ?? null,
        opportunity_title: opportunities.find((o) => o.id === opportunityId)?.title ?? null,
      })
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
              options={contacts.map((c) => ({ id: c.id, label: `${c.full_name} · ${formatClientPhoneDisplay(c.phone_prefix, c.phone)}` }))}
              value={contactId}
              onChange={handleContactChange}
              placeholder={t('calendar.form.searchPlaceholder')}
              searchPlaceholder={t('calendar.form.searchPlaceholder')}
              emptyLabel={t('tasks.filter.noResults')}
              className="w-full"
              triggerClassName="min-w-0 flex-1 shrink !rounded-lg"
            />
          </div>
          <FieldError message={contactError} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="appt-date">{t('calendar.form.date')}</Label>
            <Input id="appt-date" type="date" value={date} aria-invalid={!!dateError} onChange={(e) => setDate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="appt-start">{t('calendar.form.startTime')}</Label>
            <Input id="appt-start" type="time" value={startTime} aria-invalid={!!dateError} onChange={(e) => setStartTime(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
        </div>
        <FieldError message={dateError} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="appt-duration">{t('calendar.form.duration')}</Label>
            <Select value={String(durationMinutes)} onValueChange={(v) => setDurationMinutes(Number(v))}>
              <SelectTrigger id="appt-duration" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {durationOptions.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)} className="text-xs">
                    {formatDuration(minutes, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t('calendar.form.assignedTo')}</Label>
            <div className="mt-1">
              <ComboboxFilter
                options={agents.map((a) => ({ id: a.id, label: a.full_name }))}
                value={assignedTo}
                onChange={setAssignedTo}
                placeholder={t('calendar.form.unassigned')}
                searchPlaceholder={t('contacts.filters.agent.search')}
                emptyLabel={t('contacts.filters.agent.noResults')}
                className="w-full"
                triggerClassName="min-w-0 flex-1 shrink !rounded-lg"
              />
            </div>
          </div>
        </div>

        <div>
          <Label>{t('calendar.form.opportunity')}</Label>
          <div className="mt-1">
            <ComboboxFilter
              options={opportunities.map((o) => ({ id: o.id, label: o.title }))}
              value={opportunityId}
              onChange={setOpportunityId}
              placeholder={t('calendar.form.noOpportunity')}
              searchPlaceholder={t('calendar.form.searchPlaceholder')}
              emptyLabel={t('tasks.filter.noResults')}
              className="w-full"
              triggerClassName="min-w-0 flex-1 shrink !rounded-lg"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="appt-notes">{t('calendar.form.notes')}</Label>
          <Textarea id="appt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('calendar.form.notesPlaceholder')} rows={2} className={`mt-1 ${TEXTAREA_CLASS}`} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

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
