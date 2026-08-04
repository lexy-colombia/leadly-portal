import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getContact, createNote, listNotes } from '../../lib/api/contacts'
import { listAppointmentsForContact, updateAppointmentStatus } from '../../lib/api/appointments'
import { conversationDisplayName, listConversationsForContact } from '../../lib/api/conversations'
import type { ConversationWithLine } from '../../lib/api/conversations'
import type { CrmAppointment, CrmContact, CrmNote } from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { Badge, Button, Card, EmptyState, InitialsAvatar, PageSpinner, Textarea } from '../../components/ui'
import { CalendarIcon, ChatBubbleIcon, CheckIcon, PencilIcon, PlusIcon, XCircleIcon } from '../../components/icons'
import { ContactDrawer, STAGE_LABEL } from './contacts/ContactDrawer'
import { AppointmentDrawer } from './contacts/AppointmentDrawer'
import type { AppointmentStatus, ContactStage } from '../../types/domain'

const STAGE_TONE: Record<ContactStage, 'neutral' | 'success' | 'warning' | 'danger'> = {
  lead: 'neutral',
  contactado: 'warning',
  negociacion: 'warning',
  cliente: 'success',
  perdido: 'danger',
}

const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  activa: 'Programada',
  completada: 'Completada',
  cancelada: 'Cancelada',
}

const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  activa: 'warning',
  completada: 'success',
  cancelada: 'danger',
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function ContactoDetalle() {
  const { id } = useParams<{ id: string }>()
  const [contact, setContact] = useState<CrmContact | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    getContact(id)
      .then((data) => active && setContact(data))
      .catch((err) => active && setError(err.message ?? 'No se pudo cargar el cliente.'))
    return () => {
      active = false
    }
  }, [id])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (contact === undefined) return <PageSpinner />
  if (contact === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">No encontramos este cliente.</p>
        <Link to="/app/clientes" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          Volver a Clientes
        </Link>
      </div>
    )
  }

  return <ContactoDetalleContent contact={contact} onContactChange={setContact} />
}

type ActivityItem =
  | { kind: 'appointment'; date: string; appointment: CrmAppointment }
  | { kind: 'note'; date: string; note: CrmNote }

function ContactoDetalleContent({
  contact,
  onContactChange,
}: {
  contact: CrmContact
  onContactChange: (c: CrmContact) => void
}) {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'actividad' | 'conversaciones'>('actividad')
  const [notes, setNotes] = useState<CrmNote[] | null>(null)
  const [appointments, setAppointments] = useState<CrmAppointment[] | null>(null)
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [apptDrawerOpen, setApptDrawerOpen] = useState(false)

  function reloadAppointments() {
    listAppointmentsForContact(contact.id).then(setAppointments).catch(() => setAppointments([]))
  }

  useEffect(() => {
    listNotes(contact.id).then(setNotes).catch(() => setNotes([]))
    reloadAppointments()
    listConversationsForContact(contact.id).then(setConversations).catch(() => setConversations([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id])

  async function handleAddNote(e: FormEvent) {
    e.preventDefault()
    if (!noteDraft.trim() || !profile?.tenant_id) return
    setSavingNote(true)
    try {
      const note = await createNote(profile.tenant_id, contact.id, noteDraft.trim())
      setNotes((prev) => (prev ? [note, ...prev] : [note]))
      setNoteDraft('')
    } catch {
      /* the input keeps the draft on failure so the agent doesn't lose what they typed */
    } finally {
      setSavingNote(false)
    }
  }

  async function handleAppointmentStatus(id: string, status: AppointmentStatus) {
    setAppointments((prev) => (prev ? prev.map((a) => (a.id === id ? { ...a, status } : a)) : prev))
    try {
      await updateAppointmentStatus(id, status)
    } catch {
      reloadAppointments()
    }
  }

  const nextAppointment = useMemo(() => {
    if (!appointments) return null
    const now = Date.now()
    return (
      appointments
        .filter((a) => a.status === 'activa' && new Date(a.scheduled_at).getTime() >= now)
        .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())[0] ?? null
    )
  }, [appointments])

  const timeline = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []
    for (const a of appointments ?? []) {
      if (a.id === nextAppointment?.id) continue
      items.push({ kind: 'appointment', date: a.scheduled_at, appointment: a })
    }
    for (const n of notes ?? []) items.push({ kind: 'note', date: n.created_at, note: n })
    return items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }, [appointments, notes, nextAppointment])

  return (
    <div className="space-y-4">
      <Link to="/app/clientes" className="text-sm font-medium text-brand-400 hover:text-brand-700">
        ← Volver a Clientes
      </Link>

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <InitialsAvatar name={contact.full_name} size="lg" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold text-brand-800">{contact.full_name}</h1>
                <Badge tone={STAGE_TONE[contact.stage]}>{STAGE_LABEL[contact.stage]}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-brand-500">
                <span>{contact.phone}</span>
                {contact.email && <span>{contact.email}</span>}
                {contact.company && <span>{contact.company}</span>}
              </div>
              {contact.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {contact.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-500">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={() => setApptDrawerOpen(true)} className="!px-3.5 !py-2 text-xs">
              <CalendarIcon width={14} height={14} /> Agendar cita
            </Button>
            <Button variant="ghost" onClick={() => setEditOpen(true)} className="!px-3 !py-2 text-xs">
              <PencilIcon width={14} height={14} /> Editar
            </Button>
          </div>
        </div>
      </Card>

      {nextAppointment && (
        <Card className="border-accent-200 bg-accent-50/50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-700">
                <CalendarIcon width={18} height={18} />
              </span>
              <div>
                <p className="text-sm font-semibold text-brand-800">Próxima cita: {formatDateTime(nextAppointment.scheduled_at)}</p>
                {nextAppointment.notes && <p className="text-xs text-brand-500">{nextAppointment.notes}</p>}
                <p className="text-xs text-accent-700">
                  {nextAppointment.reminder_sent_at ? 'Recordatorio enviado por WhatsApp' : 'Le avisaremos por WhatsApp una hora antes'}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => handleAppointmentStatus(nextAppointment.id, 'completada')} className="!px-3 !py-1.5 text-xs">
                <CheckIcon width={13} height={13} /> Completada
              </Button>
              <Button variant="ghost" onClick={() => handleAppointmentStatus(nextAppointment.id, 'cancelada')} className="!px-3 !py-1.5 text-xs">
                <XCircleIcon width={13} height={13} /> Cancelar
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="flex gap-1 border-b border-brand-100">
        {(
          [
            ['actividad', 'Actividad'],
            ['conversaciones', 'Conversaciones'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === value ? 'border-accent-500 text-accent-700' : 'border-transparent text-brand-400 hover:text-brand-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'actividad' && (
        <Card>
          <form onSubmit={handleAddNote} className="mb-5 space-y-2">
            <Textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Agrega una nota sobre este cliente (una llamada, un acuerdo, un recordatorio...)"
              rows={2}
            />
            <Button type="submit" variant="secondary" disabled={savingNote || !noteDraft.trim()} className="!px-3.5 !py-1.5 text-xs">
              <PlusIcon width={13} height={13} /> {savingNote ? 'Guardando…' : 'Agregar nota'}
            </Button>
          </form>

          {(!notes || !appointments) && <PageSpinner />}
          {notes && appointments && timeline.length === 0 && <EmptyState>Sin actividad todavía.</EmptyState>}
          {notes && appointments && timeline.length > 0 && (
            <ul className="space-y-3">
              {timeline.map((item) => (
                <li key={`${item.kind}-${item.kind === 'appointment' ? item.appointment.id : item.note.id}`} className="flex gap-3">
                  <span
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      item.kind === 'appointment' ? 'bg-accent-100 text-accent-700' : 'bg-brand-100 text-brand-500'
                    }`}
                  >
                    {item.kind === 'appointment' ? <CalendarIcon width={14} height={14} /> : <PencilIcon width={13} height={13} />}
                  </span>
                  <div className="min-w-0 flex-1 rounded-xl bg-brand-50 px-4 py-3">
                    {item.kind === 'appointment' ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-brand-700">Cita: {formatDateTime(item.appointment.scheduled_at)}</p>
                        <Badge tone={APPOINTMENT_STATUS_TONE[item.appointment.status]}>
                          {APPOINTMENT_STATUS_LABEL[item.appointment.status]}
                        </Badge>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap text-sm text-brand-700">{item.note.content}</p>
                    )}
                    {item.kind === 'appointment' && item.appointment.notes && (
                      <p className="mt-0.5 text-sm text-brand-500">{item.appointment.notes}</p>
                    )}
                    <p className="mt-1.5 text-xs text-brand-400">{formatDateTime(item.date)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'conversaciones' && (
        <Card>
          {!conversations && <PageSpinner />}
          {conversations && conversations.length === 0 && <EmptyState>Todavía no hay conversaciones con este cliente.</EmptyState>}
          {conversations && conversations.length > 0 && (
            <div className="space-y-2">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => navigate(`/app?c=${conv.id}`)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3 text-left transition-colors hover:bg-brand-50"
                >
                  <span className="flex items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                      <ChatBubbleIcon width={14} height={14} />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-brand-800">{conv.whatsapp_line?.display_name ?? 'Línea'}</span>
                      <span className="block text-xs text-brand-400">
                        {conversationDisplayName(conv)} · {conv.mode === 'ia' ? 'Modo IA' : 'Modo humano'} ·{' '}
                        {conv.status === 'open' ? 'Abierta' : 'Cerrada'}
                      </span>
                    </span>
                  </span>
                  {conv.last_message_at && <span className="text-xs text-brand-300">{formatDateTime(conv.last_message_at)}</span>}
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {profile?.tenant_id && (
        <>
          <ContactDrawer open={editOpen} onClose={() => setEditOpen(false)} tenantId={profile.tenant_id} contact={contact} onSaved={onContactChange} />
          <AppointmentDrawer
            open={apptDrawerOpen}
            onClose={() => setApptDrawerOpen(false)}
            tenantId={profile.tenant_id}
            contactId={contact.id}
            onCreated={(a) => setAppointments((prev) => (prev ? [...prev, a] : [a]))}
          />
        </>
      )}
    </div>
  )
}
