import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language, TranslationKey } from '../../i18n/translations'
import { getContact, createNote, listNotes } from '../../lib/api/contacts'
import { listAppointmentsForContact, updateAppointmentStatus } from '../../lib/api/appointments'
import { listConversationsForContact } from '../../lib/api/conversations'
import type { ConversationWithLine } from '../../lib/api/conversations'
import { listPqrsForContact, updatePqrStatus } from '../../lib/api/pqrs'
import { createPqrUpdate, listPqrUpdates } from '../../lib/api/pqrUpdates'
import { listAttachmentsForPqr, listAttachmentsForPqrUpdates, uploadPqrAttachment } from '../../lib/api/attachments'
import { listProfilesByTenant } from '../../lib/api/users'
import { listOpportunitiesForContact, type OpportunityWithRelations } from '../../lib/api/opportunities'
import { listOrdersForContact, type OrderWithRelations } from '../../lib/api/orders'
import { listAddressesForContact, deleteAddress } from '../../lib/api/addresses'
import { listTasksForAccount, type TaskWithRelations } from '../../lib/api/tasks'
import { listPipelinesByTenant } from '../../lib/api/pipelines'
import type {
  CrmAppointment,
  CrmAttachment,
  CrmContact,
  CrmContactAddress,
  CrmNote,
  CrmPipeline,
  CrmPqr,
  CrmPqrUpdate,
  OrderStatus,
  Profile,
  PqrStatus,
} from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { Badge, Button, Card, ConfirmDialog, EmptyState, InitialsAvatar, PageSpinner, Pagination, Select, Textarea } from '../../components/ui'
import { ImageAttachmentPicker } from '../../components/ImageAttachmentPicker'
import { SignedImage } from '../../components/AttachmentImage'
import {
  AlertIcon,
  BuildingIcon,
  CalendarIcon,
  ChatBubbleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  MailIcon,
  MapPinIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  TrashIcon,
  UserIcon,
  XCircleIcon,
} from '../../components/icons'
import { ContactDrawer, STAGE_LABEL } from './contacts/ContactDrawer'
import { AppointmentDrawer } from './contacts/AppointmentDrawer'
import { PqrDrawer, PQR_TYPE_LABEL } from './contacts/PqrDrawer'
import { AddressDrawer } from './contacts/AddressDrawer'
import { OpportunityPanel } from './opportunities/OpportunityPanel'
import { OpportunityDrawer } from './opportunities/OpportunityDrawer'
import { OrderDrawer } from './orders/OrderDrawer'
import type { AppointmentStatus, ContactStage, PqrType } from '../../types/domain'

const ORDER_STATUS_LABEL: Record<OrderStatus, TranslationKey> = {
  cotizacion: 'contacts.order.status.cotizacion',
  confirmada: 'contacts.order.status.confirmada',
  en_proceso: 'contacts.order.status.en_proceso',
  entregada: 'contacts.order.status.entregada',
  cancelada: 'contacts.order.status.cancelada',
}

const ORDER_STATUS_TONE: Record<OrderStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  cotizacion: 'neutral',
  confirmada: 'success',
  en_proceso: 'warning',
  entregada: 'success',
  cancelada: 'danger',
}

// Currency stays Colombian-peso-formatted regardless of the active UI
// language -- it's the real business currency, not a language preference.
function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

const STAGE_TONE: Record<ContactStage, 'neutral' | 'success' | 'warning' | 'danger'> = {
  lead: 'neutral',
  contactado: 'warning',
  negociacion: 'warning',
  cliente: 'success',
  perdido: 'danger',
}

const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, TranslationKey> = {
  activa: 'contacts.appointment.status.activa',
  completada: 'contacts.appointment.status.completada',
  cancelada: 'contacts.appointment.status.cancelada',
}

const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  activa: 'warning',
  completada: 'success',
  cancelada: 'danger',
}

const PQR_TYPE_TONE: Record<PqrType, 'neutral' | 'success' | 'warning' | 'danger'> = {
  peticion: 'neutral',
  queja: 'warning',
  reclamo: 'danger',
}

const PQR_STATUS_LABEL: Record<PqrStatus, TranslationKey> = {
  abierto: 'contacts.pqr.status.abierto',
  en_proceso: 'contacts.pqr.status.en_proceso',
  resuelto: 'contacts.pqr.status.resuelto',
  cerrado: 'contacts.pqr.status.cerrado',
}

const PAGE_SIZE = 8

function paginate<T>(items: T[], page: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  return { items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), totalPages }
}

function formatDateTime(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatDate(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' })
}

/** Label-above-value field, used throughout the sidebar's data sheet -- one
 * shape for every fact about the contact (fecha de creación, último
 * contacto, teléfono, ...) instead of mixing different layouts per field. */
function Field({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-brand-300">{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs text-brand-400">{label}</dt>
        <dd className="truncate text-brand-700">{value}</dd>
      </div>
    </div>
  )
}

/** One tile per loggable activity type (nota/cita/PQR) -- gives all three
 * the same one-click access instead of only "Agendar cita" having a
 * shortcut and notes being buried inside the Actividad tab. Seguimientos
 * aren't a shortcut here on purpose -- they only make sense attached to an
 * existing PQR, so they're added from inside that PQR (tab "PQR"), not from
 * a blank quick action that would have nothing to attach to yet. */
function QuickAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-xl border border-brand-100 py-2.5 text-brand-500 transition-colors hover:border-accent-200 hover:bg-accent-50 hover:text-accent-700"
    >
      {icon}
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  )
}

/** Small pill marking something the AI created/changed on its own, so an
 * agent reading the history can tell it apart from what a human entered. */
function AiBadge() {
  return <span className="shrink-0 rounded-full bg-accent-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-700">IA</span>
}

/** Groups a flat attachments list by whichever parent it belongs to (a PQR
 * itself, or one of its seguimientos) -- pqr_id/pqr_update_id are mutually
 * exclusive per the DB check constraint, so using whichever is set as the
 * key is safe. */
function groupAttachmentsByParent(attachments: CrmAttachment[]): Record<string, CrmAttachment[]> {
  const grouped: Record<string, CrmAttachment[]> = {}
  for (const a of attachments) {
    const key = a.pqr_id ?? a.pqr_update_id
    if (!key) continue
    grouped[key] = [...(grouped[key] ?? []), a]
  }
  return grouped
}

function AttachmentThumbnails({ attachments }: { attachments: CrmAttachment[] | undefined }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((a) => (
        <SignedImage key={a.id} storagePath={a.storage_path} className="h-16 w-16" />
      ))}
    </div>
  )
}

export function ContactoDetalle() {
  const { t } = useLanguage()
  const { id } = useParams<{ id: string }>()
  const [contact, setContact] = useState<CrmContact | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    getContact(id)
      .then((data) => active && setContact(data))
      .catch((err) => active && setError(err.message ?? t('contacts.detail.errors.load')))
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
  if (contact === undefined) return <PageSpinner />
  if (contact === null) {
    return (
      <div className="space-y-4">
        <p className="text-brand-500">{t('contacts.detail.notFound')}</p>
        <Link to="/app/clientes" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          {t('contacts.detail.backToContacts')}
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
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'resumen' | 'actividad' | 'oportunidades' | 'ventas' | 'pqr' | 'conversaciones' | 'direcciones'>('resumen')
  const [page, setPage] = useState(1)
  const [notes, setNotes] = useState<CrmNote[] | null>(null)
  const [appointments, setAppointments] = useState<CrmAppointment[] | null>(null)
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [pqrs, setPqrs] = useState<CrmPqr[] | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[] | null>(null)
  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [addresses, setAddresses] = useState<CrmContactAddress[] | null>(null)
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [pipelines, setPipelines] = useState<CrmPipeline[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [apptDrawerOpen, setApptDrawerOpen] = useState(false)
  const [pqrDrawerOpen, setPqrDrawerOpen] = useState(false)
  const [selectedOpportunity, setSelectedOpportunity] = useState<OpportunityWithRelations | null>(null)
  const [opportunityDrawer, setOpportunityDrawer] = useState<{ open: boolean; opportunity: OpportunityWithRelations | null }>({
    open: false,
    opportunity: null,
  })
  const [orderDrawer, setOrderDrawer] = useState<{ open: boolean; order: OrderWithRelations | null }>({ open: false, order: null })
  const [addressDrawer, setAddressDrawer] = useState<{ open: boolean; address: CrmContactAddress | null }>({ open: false, address: null })
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null)

  const [expandedPqrId, setExpandedPqrId] = useState<string | null>(null)
  const [pqrUpdatesById, setPqrUpdatesById] = useState<Record<string, CrmPqrUpdate[]>>({})
  const [pqrUpdateDraft, setPqrUpdateDraft] = useState('')
  const [pqrUpdateAttachment, setPqrUpdateAttachment] = useState<File | null>(null)
  const [savingPqrUpdate, setSavingPqrUpdate] = useState(false)
  // Keyed by pqr_id or pqr_update_id -- covers a photo attached directly to
  // the PQR (e.g. the initial evidence) and one attached to any of its
  // seguimientos.
  const [attachmentsByParent, setAttachmentsByParent] = useState<Record<string, CrmAttachment[]>>({})

  function reloadAppointments() {
    listAppointmentsForContact(contact.id).then(setAppointments).catch(() => setAppointments([]))
  }

  function reloadOrders() {
    listOrdersForContact(contact.id).then(setOrders).catch(() => setOrders([]))
  }

  function reloadAddresses() {
    listAddressesForContact(contact.id).then(setAddresses).catch(() => setAddresses([]))
  }

  function reloadOpportunities() {
    listOpportunitiesForContact(contact.id).then(setOpportunities).catch(() => setOpportunities([]))
  }

  useEffect(() => {
    listNotes(contact.id).then(setNotes).catch(() => setNotes([]))
    reloadAppointments()
    listConversationsForContact(contact.id).then(setConversations).catch(() => setConversations([]))
    listPqrsForContact(contact.id).then(setPqrs).catch(() => setPqrs([]))
    reloadOpportunities()
    reloadOrders()
    reloadAddresses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id])

  useEffect(() => {
    if (!profile?.tenant_id) return
    listProfilesByTenant(profile.tenant_id).then(setAgents).catch(() => {})
    listPipelinesByTenant(profile.tenant_id).then(setPipelines).catch(() => {})
  }, [profile?.tenant_id])

  // "Tareas pendientes" tile on Resumen -- reuses listTasksForAccount (name
  // is a holdover from the since-reverted Empresas/B2B model, see CLAUDE.md
  // 08-08) filtered to just this one contact and its own opportunities.
  useEffect(() => {
    if (opportunities === null) return
    listTasksForAccount([contact.id], opportunities.map((o) => o.id)).then(setTasks).catch(() => setTasks([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id, opportunities])

  useEffect(() => {
    setPage(1)
  }, [tab])

  // Loads each PQR's own attachments (photos attached directly to the case,
  // not to one of its seguimientos) up front -- shown in the collapsed card
  // header, so it can't wait for the "Ver seguimientos" expand action.
  useEffect(() => {
    if (!pqrs || pqrs.length === 0) return
    const idsToLoad = pqrs.map((p) => p.id).filter((id) => !(id in attachmentsByParent))
    if (idsToLoad.length === 0) return
    Promise.all(idsToLoad.map((id) => listAttachmentsForPqr(id).catch(() => [] as CrmAttachment[]))).then((results) => {
      setAttachmentsByParent((prev) => {
        const next = { ...prev }
        idsToLoad.forEach((id, i) => {
          next[id] = results[i]
        })
        return next
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pqrs])

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

  async function handlePqrStatus(id: string, status: PqrStatus) {
    setPqrs((prev) => (prev ? prev.map((p) => (p.id === id ? { ...p, status } : p)) : prev))
    try {
      await updatePqrStatus(id, status)
      if (profile?.tenant_id) {
        const update = await createPqrUpdate(profile.tenant_id, id, t('contacts.detail.pqr.statusChanged', { status: t(PQR_STATUS_LABEL[status]) }))
        setPqrUpdatesById((prev) => (prev[id] ? { ...prev, [id]: [update, ...prev[id]] } : prev))
      }
    } catch {
      listPqrsForContact(contact.id).then(setPqrs).catch(() => {})
    }
  }

  function toggleExpandPqr(pqrId: string) {
    if (expandedPqrId === pqrId) {
      setExpandedPqrId(null)
      return
    }
    setExpandedPqrId(pqrId)
    setPqrUpdateDraft('')
    setPqrUpdateAttachment(null)
    if (!pqrUpdatesById[pqrId]) {
      listPqrUpdates(pqrId)
        .then((updates) => {
          setPqrUpdatesById((prev) => ({ ...prev, [pqrId]: updates }))
          if (updates.length === 0) return
          listAttachmentsForPqrUpdates(updates.map((u) => u.id))
            .then((attachments) => setAttachmentsByParent((prev) => ({ ...prev, ...groupAttachmentsByParent(attachments) })))
            .catch(() => {})
        })
        .catch(() => {})
    }
  }

  async function handleDeleteAddress() {
    if (!deleteAddressId) return
    try {
      await deleteAddress(deleteAddressId)
      setDeleteAddressId(null)
      reloadAddresses()
    } catch {
      setDeleteAddressId(null)
    }
  }

  async function handleAddPqrUpdate(e: FormEvent, pqrId: string) {
    e.preventDefault()
    if (!pqrUpdateDraft.trim() || !profile?.tenant_id) return
    setSavingPqrUpdate(true)
    try {
      const update = await createPqrUpdate(profile.tenant_id, pqrId, pqrUpdateDraft.trim())
      setPqrUpdatesById((prev) => ({ ...prev, [pqrId]: [update, ...(prev[pqrId] ?? [])] }))
      if (pqrUpdateAttachment) {
        try {
          const attachment = await uploadPqrAttachment(profile.tenant_id, pqrUpdateAttachment, { pqrUpdateId: update.id })
          setAttachmentsByParent((prev) => ({ ...prev, [update.id]: [attachment] }))
        } catch (attachmentErr) {
          console.error('No se pudo subir la imagen del seguimiento', attachmentErr)
        }
      }
      setPqrUpdateDraft('')
      setPqrUpdateAttachment(null)
    } catch {
      /* keep the draft on failure so the agent doesn't lose what they typed */
    } finally {
      setSavingPqrUpdate(false)
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

  const lastContactAt = useMemo(() => {
    const dates: string[] = []
    for (const c of conversations ?? []) if (c.last_message_at) dates.push(c.last_message_at)
    if (notes?.[0]) dates.push(notes[0].created_at)
    return dates.length > 0 ? dates.reduce((max, d) => (d > max ? d : max)) : null
  }, [conversations, notes])

  const assignedAgentName = agents.find((a) => a.id === contact.assigned_to)?.full_name ?? null

  const timelinePage = useMemo(() => paginate(timeline, page), [timeline, page])
  const pqrsPage = useMemo(() => paginate(pqrs ?? [], page), [pqrs, page])
  const conversationsPage = useMemo(() => paginate(conversations ?? [], page), [conversations, page])
  const opportunitiesPage = useMemo(() => paginate(opportunities ?? [], page), [opportunities, page])
  const ordersPage = useMemo(() => paginate(orders ?? [], page), [orders, page])
  const addressesPage = useMemo(() => paginate(addresses ?? [], page), [addresses, page])

  const openOpportunities = useMemo(() => (opportunities ?? []).filter((o) => o.status === 'open'), [opportunities])
  const openOpportunitiesValue = useMemo(() => openOpportunities.reduce((sum, o) => sum + o.value, 0), [openOpportunities])
  const confirmedOrders = useMemo(() => (orders ?? []).filter((o) => o.status !== 'cotizacion' && o.status !== 'cancelada'), [orders])
  const confirmedOrdersValue = useMemo(() => confirmedOrders.reduce((sum, o) => sum + o.total, 0), [confirmedOrders])
  const pendingQuotes = useMemo(() => (orders ?? []).filter((o) => o.status === 'cotizacion'), [orders])
  const pendingTasks = useMemo(() => (tasks ?? []).filter((t) => t.status !== 'completada' && t.status !== 'cancelada'), [tasks])

  const pipelineNameById = useMemo(() => Object.fromEntries(pipelines.map((p) => [p.id, p.name])), [pipelines])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <Card className="lg:w-72 lg:shrink-0">
          <div className="flex items-start justify-between gap-2 pb-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <InitialsAvatar name={contact.full_name} size="md" />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-brand-800">{contact.full_name}</p>
                <Badge tone={STAGE_TONE[contact.stage]}>{t(STAGE_LABEL[contact.stage])}</Badge>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="shrink-0 rounded-lg p-1.5 text-brand-400 transition-colors hover:bg-brand-50 hover:text-brand-700"
              aria-label={t('contacts.detail.aria.edit')}
            >
              <PencilIcon width={15} height={15} />
            </button>
          </div>

          <dl className="space-y-3 border-t border-brand-100 py-4 text-sm">
            <Field icon={<CalendarIcon width={14} height={14} />} label={t('contacts.detail.fields.createdAt')} value={formatDate(contact.created_at, language)} />
            <Field
              icon={<ClockIcon width={14} height={14} />}
              label={t('contacts.detail.fields.lastContact')}
              value={lastContactAt ? formatDateTime(lastContactAt, language) : t('contacts.detail.fields.lastContact.none')}
            />
            <Field icon={<PhoneIcon width={14} height={14} />} label={t('contacts.detail.fields.phone')} value={contact.phone} />
            {contact.email && <Field icon={<MailIcon width={14} height={14} />} label={t('contacts.detail.fields.email')} value={contact.email} />}
            {contact.company && <Field icon={<BuildingIcon width={14} height={14} />} label={t('contacts.detail.fields.company')} value={contact.company} />}
            {contact.city && <Field icon={<MapPinIcon width={14} height={14} />} label={t('contacts.detail.fields.city')} value={contact.city} />}
            <Field
              icon={<UserIcon width={14} height={14} />}
              label={t('contacts.detail.fields.assignedAgent')}
              value={assignedAgentName ?? t('contacts.detail.fields.unassigned')}
            />
          </dl>

          {contact.tags.length > 0 && (
            <div className="border-t border-brand-100 py-4">
              <p className="mb-2 text-xs font-medium text-brand-400">{t('contacts.detail.tags.label')}</p>
              <div className="flex flex-wrap gap-1.5">
                {contact.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-500">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 border-t border-brand-100 pt-4">
            <QuickAction icon={<PencilIcon width={16} height={16} />} label={t('contacts.detail.quickActions.note')} onClick={() => setTab('actividad')} />
            <QuickAction icon={<CalendarIcon width={16} height={16} />} label={t('contacts.detail.quickActions.appointment')} onClick={() => setApptDrawerOpen(true)} />
            <QuickAction icon={<AlertIcon width={16} height={16} />} label={t('contacts.detail.quickActions.pqr')} onClick={() => setPqrDrawerOpen(true)} />
          </div>
        </Card>

        <div className="min-w-0 flex-1 space-y-4">
          {nextAppointment && (
            <Card className="border-accent-200 bg-accent-50/50">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-700">
                    <CalendarIcon width={18} height={18} />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-brand-800">
                      {t('contacts.detail.nextAppointment.title', { date: formatDateTime(nextAppointment.scheduled_at, language) })}
                    </p>
                    {nextAppointment.notes && <p className="text-xs text-brand-500">{nextAppointment.notes}</p>}
                    <p className="text-xs text-accent-700">
                      {nextAppointment.reminder_sent_at
                        ? t('contacts.detail.nextAppointment.reminderSent')
                        : t('contacts.detail.nextAppointment.reminderPending')}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => handleAppointmentStatus(nextAppointment.id, 'completada')} className="!px-3 !py-1.5 text-xs">
                    <CheckIcon width={13} height={13} /> {t('contacts.detail.nextAppointment.complete')}
                  </Button>
                  <Button variant="ghost" onClick={() => handleAppointmentStatus(nextAppointment.id, 'cancelada')} className="!px-3 !py-1.5 text-xs">
                    <XCircleIcon width={13} height={13} /> {t('contacts.detail.nextAppointment.cancel')}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          <div className="flex flex-wrap gap-1 border-b border-brand-100">
            {(
              [
                ['resumen', t('contacts.detail.tabs.summary')],
                ['actividad', t('contacts.detail.tabs.activity')],
                ['oportunidades', `${t('contacts.detail.tabs.opportunities')}${opportunities ? ` (${opportunities.length})` : ''}`],
                ['ventas', `${t('contacts.detail.tabs.sales')}${orders ? ` (${orders.length})` : ''}`],
                ['pqr', t('contacts.detail.tabs.pqr')],
                ['conversaciones', t('contacts.detail.tabs.conversations')],
                ['direcciones', `${t('contacts.detail.tabs.addresses')}${addresses ? ` (${addresses.length})` : ''}`],
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

          {tab === 'resumen' && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card className="!p-4">
                <p className="text-xs text-brand-400">{t('contacts.detail.summary.openOpportunities')}</p>
                <p className="mt-1 text-lg font-bold text-brand-800">{opportunities ? openOpportunities.length : '—'}</p>
                {opportunities && openOpportunities.length > 0 && (
                  <p className="text-xs text-brand-500">{formatCurrency(openOpportunitiesValue)}</p>
                )}
              </Card>
              <Card className="!p-4">
                <p className="text-xs text-brand-400">{t('contacts.detail.summary.confirmedSales')}</p>
                <p className="mt-1 text-lg font-bold text-brand-800">{orders ? formatCurrency(confirmedOrdersValue) : '—'}</p>
                {orders && <p className="text-xs text-brand-500">{t('contacts.detail.summary.salesCount', { count: confirmedOrders.length })}</p>}
              </Card>
              <Card className="!p-4">
                <p className="text-xs text-brand-400">{t('contacts.detail.summary.pendingQuotes')}</p>
                <p className="mt-1 text-lg font-bold text-brand-800">{orders ? pendingQuotes.length : '—'}</p>
              </Card>
              <Card className="!p-4">
                <p className="text-xs text-brand-400">{t('contacts.detail.summary.pendingTasks')}</p>
                <p className="mt-1 text-lg font-bold text-brand-800">{tasks ? pendingTasks.length : '—'}</p>
              </Card>
              {nextAppointment && (
                <Card className="col-span-2 !p-4 lg:col-span-4">
                  <p className="text-xs text-brand-400">{t('contacts.detail.summary.nextAppointment')}</p>
                  <p className="mt-1 text-sm font-semibold text-brand-800">{formatDateTime(nextAppointment.scheduled_at, language)}</p>
                </Card>
              )}
            </div>
          )}

          {tab === 'actividad' && (
            <Card>
              <form onSubmit={handleAddNote} className="mb-6 rounded-xl border border-brand-100 bg-brand-50/40 p-3 focus-within:border-accent-300">
                <Textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t('contacts.detail.activity.notePlaceholder')}
                  rows={2}
                  className="!resize-none !border-0 !bg-transparent !p-0 !shadow-none focus:!ring-0"
                />
                <div className="mt-2 flex justify-end">
                  <Button type="submit" variant="secondary" disabled={savingNote || !noteDraft.trim()} className="!px-3.5 !py-1.5 text-xs">
                    <PlusIcon width={13} height={13} /> {savingNote ? t('common.actions.saving') : t('contacts.detail.activity.addNote')}
                  </Button>
                </div>
              </form>

              {(!notes || !appointments) && <PageSpinner />}
              {notes && appointments && timeline.length === 0 && <EmptyState>{t('contacts.detail.activity.empty')}</EmptyState>}
              {notes && appointments && timeline.length > 0 && (
                <ul>
                  {timelinePage.items.map((item, idx) => (
                    <li
                      key={`${item.kind}-${item.kind === 'appointment' ? item.appointment.id : item.note.id}`}
                      className="relative flex gap-3 pb-4 last:pb-0"
                    >
                      {idx < timelinePage.items.length - 1 && (
                        <span aria-hidden="true" className="absolute left-3.5 top-7 bottom-0 w-px bg-brand-100" />
                      )}
                      <span
                        className={`relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                          item.kind === 'appointment' ? 'bg-accent-100 text-accent-700' : 'bg-brand-100 text-brand-500'
                        }`}
                      >
                        {item.kind === 'appointment' ? <CalendarIcon width={14} height={14} /> : <PencilIcon width={13} height={13} />}
                      </span>
                      <div className="min-w-0 flex-1 rounded-xl bg-brand-50 px-4 py-3">
                        {item.kind === 'appointment' ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-brand-700">
                              {t('contacts.detail.activity.appointmentLabel', { date: formatDateTime(item.appointment.scheduled_at, language) })}
                            </p>
                            <Badge tone={APPOINTMENT_STATUS_TONE[item.appointment.status]}>
                              {t(APPOINTMENT_STATUS_LABEL[item.appointment.status])}
                            </Badge>
                          </div>
                        ) : (
                          <div className="flex items-start gap-1.5">
                            <p className="whitespace-pre-wrap text-sm text-brand-700">{item.note.content}</p>
                            {item.note.created_by_ai && <AiBadge />}
                          </div>
                        )}
                        {item.kind === 'appointment' && item.appointment.notes && (
                          <p className="mt-0.5 text-sm text-brand-500">{item.appointment.notes}</p>
                        )}
                        <p className="mt-1.5 text-xs text-brand-400">{formatDateTime(item.date, language)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Pagination page={page} totalPages={timelinePage.totalPages} onChange={setPage} />
            </Card>
          )}

          {tab === 'oportunidades' && (
            <Card>
              {!opportunities && <PageSpinner />}
              {opportunities && opportunities.length === 0 && <EmptyState>{t('contacts.detail.opportunities.empty')}</EmptyState>}
              {opportunities && opportunities.length > 0 && (
                <ul className="space-y-2">
                  {opportunitiesPage.items.map((o) => (
                    <li key={o.id}>
                      <button
                        onClick={() => setSelectedOpportunity(o)}
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3 text-left transition-colors hover:bg-brand-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-brand-800">{o.title}</span>
                          <span className="block text-xs text-brand-400">{o.stage?.name ?? '—'}</span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-brand-700">{formatCurrency(o.value, o.currency)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Pagination page={page} totalPages={opportunitiesPage.totalPages} onChange={setPage} />
            </Card>
          )}

          {tab === 'ventas' && (
            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-brand-400">{t('contacts.detail.sales.description')}</p>
                <Button variant="secondary" onClick={() => setOrderDrawer({ open: true, order: null })} className="!px-3 !py-1.5 text-xs">
                  <PlusIcon width={13} height={13} /> {t('contacts.detail.sales.new')}
                </Button>
              </div>
              {!orders && <PageSpinner />}
              {orders && orders.length === 0 && <EmptyState>{t('contacts.detail.sales.empty')}</EmptyState>}
              {orders && orders.length > 0 && (
                <ul className="space-y-2">
                  {ordersPage.items.map((o) => (
                    <li key={o.id}>
                      <button
                        onClick={() => navigate(`/app/ventas/${o.id}`)}
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3 text-left transition-colors hover:bg-brand-50"
                      >
                        <span className="min-w-0">
                          <span className="font-mono text-xs font-semibold text-brand-400">ORD-{o.number}</span>
                          {o.opportunity && <span className="ml-2 truncate text-xs text-brand-400">{o.opportunity.title}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone={ORDER_STATUS_TONE[o.status]}>{t(ORDER_STATUS_LABEL[o.status])}</Badge>
                          <span className="text-sm font-semibold text-brand-700">{formatCurrency(o.total, o.currency)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Pagination page={page} totalPages={ordersPage.totalPages} onChange={setPage} />
            </Card>
          )}

          {tab === 'pqr' && (
            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-brand-400">{t('contacts.detail.pqr.description')}</p>
                <Button variant="secondary" onClick={() => setPqrDrawerOpen(true)} className="!px-3 !py-1.5 text-xs">
                  <PlusIcon width={13} height={13} /> {t('contacts.detail.pqr.new')}
                </Button>
              </div>

              {!pqrs && <PageSpinner />}
              {pqrs && pqrs.length === 0 && <EmptyState>{t('contacts.detail.pqr.empty')}</EmptyState>}
              {pqrs && pqrs.length > 0 && (
                <ul className="space-y-3">
                  {pqrsPage.items.map((p) => {
                    const isExpanded = expandedPqrId === p.id
                    const updates = pqrUpdatesById[p.id]
                    return (
                      <li key={p.id} className="rounded-xl border border-brand-100 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-brand-400">PQR-{p.code}</span>
                              <Badge tone={PQR_TYPE_TONE[p.type]}>{t(PQR_TYPE_LABEL[p.type])}</Badge>
                              <p className="text-sm font-semibold text-brand-800">{p.subject}</p>
                              {p.created_by_ai && <AiBadge />}
                            </div>
                            {p.description && <p className="mt-1.5 text-sm text-brand-500">{p.description}</p>}
                            <AttachmentThumbnails attachments={attachmentsByParent[p.id]} />
                            <p className="mt-1.5 text-xs text-brand-400">{formatDateTime(p.created_at, language)}</p>
                          </div>
                          <label className="flex shrink-0 items-center gap-1.5 text-xs text-brand-400">
                            {t('contacts.detail.pqr.statusLabel')}
                            <Select
                              value={p.status}
                              onChange={(e) => handlePqrStatus(p.id, e.target.value as PqrStatus)}
                              className="!w-auto !py-1.5 !text-xs"
                            >
                              {(Object.keys(PQR_STATUS_LABEL) as PqrStatus[]).map((s) => (
                                <option key={s} value={s}>
                                  {t(PQR_STATUS_LABEL[s])}
                                </option>
                              ))}
                            </Select>
                          </label>
                        </div>

                        <div className="mt-3 border-t border-brand-100 pt-3">
                          <Button type="button" variant="ghost" onClick={() => toggleExpandPqr(p.id)} className="!px-3 !py-1.5 text-xs">
                            <ClockIcon width={13} height={13} />
                            {isExpanded
                              ? t('contacts.detail.pqr.hideUpdates')
                              : updates
                                ? t('contacts.detail.pqr.viewUpdatesCount', { count: updates.length })
                                : t('contacts.detail.pqr.viewUpdates')}
                            <ChevronLeftIcon width={13} height={13} className={`transition-transform ${isExpanded ? '-rotate-90' : '-rotate-180'}`} />
                          </Button>
                        </div>

                        {isExpanded && (
                          <div className="mt-3 border-t border-brand-100 pt-3">
                            <form
                              onSubmit={(e) => handleAddPqrUpdate(e, p.id)}
                              className="mb-3 rounded-xl border border-brand-100 bg-brand-50/40 p-3 focus-within:border-accent-300"
                            >
                              <Textarea
                                value={pqrUpdateDraft}
                                onChange={(e) => setPqrUpdateDraft(e.target.value)}
                                placeholder={t('contacts.detail.pqr.updatePlaceholder')}
                                rows={2}
                                className="!resize-none !border-0 !bg-transparent !p-0 !shadow-none focus:!ring-0"
                              />
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                <ImageAttachmentPicker file={pqrUpdateAttachment} onChange={setPqrUpdateAttachment} />
                                <Button type="submit" variant="secondary" disabled={savingPqrUpdate || !pqrUpdateDraft.trim()} className="!px-3.5 !py-1.5 text-xs">
                                  <PlusIcon width={13} height={13} /> {savingPqrUpdate ? t('common.actions.saving') : t('contacts.detail.pqr.addUpdate')}
                                </Button>
                              </div>
                            </form>

                            {!updates && <PageSpinner />}
                            {updates && updates.length === 0 && (
                              <p className="py-2 text-center text-xs text-brand-400">{t('contacts.detail.pqr.noUpdates')}</p>
                            )}
                            {updates && updates.length > 0 && (
                              <ul className="space-y-2">
                                {updates.map((u) => (
                                  <li key={u.id} className="rounded-xl bg-brand-50 px-3.5 py-2.5">
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-mono text-[11px] font-semibold text-brand-400">
                                        PQR-{p.code}-{u.seq}
                                      </span>
                                      {u.created_by_ai && <AiBadge />}
                                    </div>
                                    <p className="mt-1 whitespace-pre-wrap text-sm text-brand-700">{u.content}</p>
                                    <AttachmentThumbnails attachments={attachmentsByParent[u.id]} />
                                    <p className="mt-1 text-xs text-brand-400">{formatDateTime(u.created_at, language)}</p>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              <Pagination page={page} totalPages={pqrsPage.totalPages} onChange={setPage} />
            </Card>
          )}

          {tab === 'conversaciones' && (
            <Card>
              {!conversations && <PageSpinner />}
              {conversations && conversations.length === 0 && <EmptyState>{t('contacts.detail.conversations.empty')}</EmptyState>}
              {conversations && conversations.length > 0 && (
                <div className="space-y-2">
                  {conversationsPage.items.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => navigate(`/app?c=${conv.id}`)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3 text-left transition-colors hover:bg-brand-50"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                          <ChatBubbleIcon width={14} height={14} />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${conv.mode === 'ia' ? 'bg-accent-500' : 'bg-amber-500'}`} />
                            <span className="text-sm font-medium text-brand-800">
                              {conv.mode === 'ia' ? t('contacts.detail.conversations.modeIa') : t('contacts.detail.conversations.modeHuman')}
                            </span>
                            {conv.status === 'closed' && <Badge tone="danger">{t('contacts.detail.conversations.closed')}</Badge>}
                          </span>
                          <span className="block truncate text-xs text-brand-400">
                            {conv.whatsapp_line?.display_name ?? t('contacts.detail.conversations.line')}
                          </span>
                        </span>
                      </span>
                      {conv.last_message_at && <span className="text-xs text-brand-300">{formatDateTime(conv.last_message_at, language)}</span>}
                    </button>
                  ))}
                </div>
              )}
              <Pagination page={page} totalPages={conversationsPage.totalPages} onChange={setPage} />
            </Card>
          )}

          {tab === 'direcciones' && (
            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-brand-400">{t('contacts.detail.addresses.description')}</p>
                <Button variant="secondary" onClick={() => setAddressDrawer({ open: true, address: null })} className="!px-3 !py-1.5 text-xs">
                  <PlusIcon width={13} height={13} /> {t('contacts.detail.addresses.new')}
                </Button>
              </div>
              {!addresses && <PageSpinner />}
              {addresses && addresses.length === 0 && <EmptyState>{t('contacts.detail.addresses.empty')}</EmptyState>}
              {addresses && addresses.length > 0 && (
                <ul className="space-y-2">
                  {addressesPage.items.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {a.label && <p className="text-sm font-semibold text-brand-800">{a.label}</p>}
                          {a.is_default && <Badge tone="success">{t('contacts.detail.addresses.default')}</Badge>}
                          {a.is_shipping && <Badge tone="neutral">{t('contacts.detail.addresses.shipping')}</Badge>}
                          {a.is_billing && <Badge tone="neutral">{t('contacts.detail.addresses.billing')}</Badge>}
                        </div>
                        <p className="mt-1 text-sm text-brand-700">
                          {a.line1}
                          {a.line2 ? `, ${a.line2}` : ''}
                          {a.city ? `, ${a.city}` : ''}
                        </p>
                        {a.notes && <p className="mt-0.5 text-xs text-brand-400">{a.notes}</p>}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setAddressDrawer({ open: true, address: a })}
                          className="rounded-lg p-1.5 text-brand-400 transition-colors hover:bg-brand-50 hover:text-brand-700"
                          aria-label={t('contacts.detail.addresses.aria.edit')}
                        >
                          <PencilIcon width={14} height={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteAddressId(a.id)}
                          className="rounded-lg p-1.5 text-brand-400 transition-colors hover:bg-red-50 hover:text-red-600"
                          aria-label={t('contacts.detail.addresses.aria.delete')}
                        >
                          <TrashIcon width={14} height={14} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Pagination page={page} totalPages={addressesPage.totalPages} onChange={setPage} />
            </Card>
          )}
        </div>
      </div>

      {profile?.tenant_id && (
        <>
          <ContactDrawer open={editOpen} onClose={() => setEditOpen(false)} tenantId={profile.tenant_id} contact={contact} onSaved={onContactChange} />
          <AddressDrawer
            open={addressDrawer.open}
            onClose={() => setAddressDrawer({ open: false, address: null })}
            tenantId={profile.tenant_id}
            contactId={contact.id}
            address={addressDrawer.address}
            onSaved={reloadAddresses}
          />
          <ConfirmDialog
            open={!!deleteAddressId}
            onClose={() => setDeleteAddressId(null)}
            onConfirm={handleDeleteAddress}
            title={t('contacts.detail.addresses.deleteConfirm.title')}
            description={t('contacts.detail.addresses.deleteConfirm.description')}
          />
          <OrderDrawer
            open={orderDrawer.open}
            onClose={() => setOrderDrawer({ open: false, order: null })}
            tenantId={profile.tenant_id}
            order={orderDrawer.order}
            defaultContactId={contact.id}
            onSaved={reloadOrders}
          />
          <OpportunityPanel
            open={!!selectedOpportunity}
            onClose={() => setSelectedOpportunity(null)}
            tenantId={profile.tenant_id}
            pipelineName={selectedOpportunity ? pipelineNameById[selectedOpportunity.pipeline_id] ?? '—' : '—'}
            opportunity={selectedOpportunity}
            onEdit={(o) => {
              setSelectedOpportunity(null)
              setOpportunityDrawer({ open: true, opportunity: o })
            }}
            onChanged={reloadOpportunities}
          />
          <OpportunityDrawer
            open={opportunityDrawer.open}
            onClose={() => setOpportunityDrawer({ open: false, opportunity: null })}
            tenantId={profile.tenant_id}
            pipelineId={opportunityDrawer.opportunity?.pipeline_id ?? null}
            opportunity={opportunityDrawer.opportunity}
            onSaved={reloadOpportunities}
          />
          <AppointmentDrawer
            open={apptDrawerOpen}
            onClose={() => setApptDrawerOpen(false)}
            tenantId={profile.tenant_id}
            contactId={contact.id}
            onCreated={(a) => setAppointments((prev) => (prev ? [...prev, a] : [a]))}
          />
          <PqrDrawer
            open={pqrDrawerOpen}
            onClose={() => setPqrDrawerOpen(false)}
            tenantId={profile.tenant_id}
            contactId={contact.id}
            onCreated={(p) => {
              setPqrs((prev) => (prev ? [p, ...prev] : [p]))
              setTab('pqr')
            }}
          />
        </>
      )}
    </div>
  )
}
