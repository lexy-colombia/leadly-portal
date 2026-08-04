import { useEffect, useState, type FormEvent } from 'react'
import { createAppointment } from '../../../lib/api/appointments'
import type { CrmAppointment } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Textarea } from '../../../components/ui'

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
  onCreated: (appointment: CrmAppointment) => void
}) {
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

  const dateError = touched && !dateTime ? 'Elige fecha y hora.' : undefined
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
      setFormError(err instanceof Error ? err.message : 'No se pudo agendar la cita.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Agendar cita"
      description="Le enviamos un recordatorio por WhatsApp una hora antes."
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="appt-datetime">Fecha y hora</Label>
          <Input id="appt-datetime" type="datetime-local" value={dateTime} invalid={!!dateError} onChange={(e) => setDateTime(e.target.value)} />
          <FieldError message={dateError} />
          {!dateError && isPast && <p className="mt-1 text-xs text-amber-600">Esa fecha ya pasó -- no se enviará recordatorio.</p>}
        </div>

        <div>
          <Label htmlFor="appt-notes">Notas (opcional)</Label>
          <Textarea id="appt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Motivo de la cita, temas a tratar..." rows={3} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? 'Agendando…' : 'Agendar cita'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
