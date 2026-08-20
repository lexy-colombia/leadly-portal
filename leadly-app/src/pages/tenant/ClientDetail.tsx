import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MoreHorizontalIcon } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language, TranslationKey } from '../../i18n/translations'
import { deleteClient, getClient, createNote, listNotes } from '../../lib/api/clients'
import { listAppointmentsForContact, updateAppointmentStatus } from '../../lib/api/appointments'
import { listConversationsForContact } from '../../lib/api/conversations'
import type { ConversationWithLine } from '../../lib/api/conversations'
import { listProfilesByTenant } from '../../lib/api/users'
import { listOpportunitiesForContact, type OpportunityWithRelations } from '../../lib/api/opportunities'
import { listOrdersForContact, type OrderWithRelations } from '../../lib/api/orders'
import { listAddressesForContact, deleteAddress } from '../../lib/api/addresses'
import { listTasksForAccount, type TaskWithRelations } from '../../lib/api/tasks'
import { listPipelinesByTenant } from '../../lib/api/pipelines'
import type {
  Appointment,
  Client,
  ContactAddress,
  Note,
  Pipeline,
  OrderStatus,
  Profile,
} from '../../types/domain'
import { useAuth } from '../../contexts/AuthContext'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CalendarIcon, CheckIcon, ChatBubbleIcon, PencilIcon, PlusIcon, TrashIcon, XCircleIcon } from '@/components/atoms/icons'
import { ContactDrawer, STAGE_LABEL } from './clients/ContactDrawer'
import { AppointmentDrawer } from './clients/AppointmentDrawer'
import { AddressDrawer } from './clients/AddressDrawer'
import { OpportunityPanel } from './opportunities/OpportunityPanel'
import { OpportunityDrawer } from './opportunities/OpportunityDrawer'
import type { AppointmentStatus, ClientStage } from '../../types/domain'

const ORDER_STATUS_LABEL: Record<OrderStatus, TranslationKey> = {
  cotizacion: 'contacts.order.status.cotizacion',
  confirmada: 'contacts.order.status.confirmada',
  en_proceso: 'contacts.order.status.en_proceso',
  entregada: 'contacts.order.status.entregada',
  cancelada: 'contacts.order.status.cancelada',
}

const ORDER_STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  cotizacion: 'border-transparent bg-slate-100 text-slate-600',
  confirmada: 'border-transparent bg-emerald-100 text-emerald-700',
  en_proceso: 'border-transparent bg-amber-100 text-amber-700',
  entregada: 'border-transparent bg-emerald-100 text-emerald-700',
  cancelada: 'border-transparent bg-red-100 text-red-700',
}

// Currency stays Colombian-peso-formatted regardless of the active UI
// language -- it's the real business currency, not a language preference.
function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

const STAGE_BADGE_CLASS: Record<ClientStage, string> = {
  lead: 'border-transparent bg-slate-100 text-slate-600',
  contactado: 'border-transparent bg-amber-100 text-amber-700',
  negociacion: 'border-transparent bg-amber-100 text-amber-700',
  cliente: 'border-transparent bg-emerald-100 text-emerald-700',
  perdido: 'border-transparent bg-red-100 text-red-700',
}

const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, TranslationKey> = {
  activa: 'contacts.appointment.status.activa',
  completada: 'contacts.appointment.status.completada',
  cancelada: 'contacts.appointment.status.cancelada',
}

const APPOINTMENT_STATUS_BADGE_CLASS: Record<AppointmentStatus, string> = {
  activa: 'border-transparent bg-amber-100 text-amber-700',
  completada: 'border-transparent bg-emerald-100 text-emerald-700',
  cancelada: 'border-transparent bg-red-100 text-red-700',
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

/** Label-above-value field -- the one fact-display shape used across both
 * header StatCards (Resumen/Detalles), same pattern as ProductDetail. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-brand-400">{label}</dt>
      <dd className="truncate text-sm font-semibold text-brand-800">{value}</dd>
    </div>
  )
}

function StatCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-brand-100 p-4">
      <h3 className="mb-3 text-sm font-semibold text-brand-800">{title}</h3>
      {children}
    </div>
  )
}

/** Bordered panel used for each tab's content -- flat, no shadow, matches
 * every other list container introduced this session (Products, Categories,
 * ProductDetail) instead of the old shadowed Card. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-brand-100 bg-white p-4">{children}</div>
}

/** Small pill marking something the AI created/changed on its own, so an
 * agent reading the history can tell it apart from what a human entered. */
function AiBadge() {
  return <span className="shrink-0 rounded-full bg-accent-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-700">IA</span>
}

export function ClientDetail() {
  const { t } = useLanguage()
  const { id } = useParams<{ id: string }>()
  const [contact, setContact] = useState<Client | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    getClient(id)
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
        <Link to="/app/clients" className="text-sm font-medium text-accent-600 hover:text-accent-700">
          {t('contacts.detail.backToContacts')}
        </Link>
      </div>
    )
  }

  return <ClientDetailContent contact={contact} onContactChange={setContact} />
}

type ActivityItem =
  | { kind: 'appointment'; date: string; appointment: Appointment }
  | { kind: 'note'; date: string; note: Note }

function ClientDetailContent({
  contact,
  onContactChange,
}: {
  contact: Client
  onContactChange: (c: Client) => void
}) {
  const { profile, enabledModules } = useAuth()
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  // Same rule as the Clientes list: "etapa" only means something when the
  // tenant has the Pipeline module on -- otherwise it's a badge nobody can
  // act on (explicit user call, see Clients.tsx).
  const showStage = enabledModules?.has('pipeline') ?? false
  const [tab, setTab] = useState('actividad')
  const [page, setPage] = useState(1)
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [appointments, setAppointments] = useState<Appointment[] | null>(null)
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[] | null>(null)
  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [addresses, setAddresses] = useState<ContactAddress[] | null>(null)
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [apptDrawerOpen, setApptDrawerOpen] = useState(false)
  const [selectedOpportunity, setSelectedOpportunity] = useState<OpportunityWithRelations | null>(null)
  const [opportunityDrawer, setOpportunityDrawer] = useState<{ open: boolean; opportunity: OpportunityWithRelations | null }>({
    open: false,
    opportunity: null,
  })
  const [addressDrawer, setAddressDrawer] = useState<{ open: boolean; address: ContactAddress | null }>({ open: false, address: null })
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

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

  // "Tasks pendientes" tile on Resumen -- reuses listTasksForAccount (name
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

  async function handleDeleteClient() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteClient(contact.id)
      navigate('/app/clients')
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('contacts.detail.deleteConfirm.error'))
      setDeleting(false)
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
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <InitialsAvatar name={contact.full_name} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-brand-800">{contact.full_name}</h1>
              {showStage && (
                <Badge variant="outline" className={STAGE_BADGE_CLASS[contact.stage]}>
                  {t(STAGE_LABEL[contact.stage])}
                </Badge>
              )}
              {!contact.is_active && <Badge variant="outline">{t('common.status.inactive')}</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-brand-400">
              <span>{contact.phone}</span>
              {contact.email && <span>{contact.email}</span>}
              {contact.company && <span>{contact.company}</span>}
              {contact.city && <span>{contact.city}</span>}
            </div>
            {contact.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {contact.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs text-brand-500">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <PencilIcon width={13} height={13} /> {t('common.actions.edit')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label={t('contacts.detail.actions.moreActions')}>
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setApptDrawerOpen(true)}>{t('contacts.detail.actions.scheduleAppointment')}</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                {t('contacts.detail.actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard title={t('contacts.detail.sections.summary')}>
          <div className="grid grid-cols-2 gap-3">
            {showStage && (
              <Field
                label={t('contacts.detail.summary.openOpportunities')}
                value={opportunities ? `${openOpportunities.length}${openOpportunities.length > 0 ? ` · ${formatCurrency(openOpportunitiesValue)}` : ''}` : '—'}
              />
            )}
            <Field label={t('contacts.detail.summary.confirmedSales')} value={orders ? formatCurrency(confirmedOrdersValue) : '—'} />
            <Field label={t('contacts.detail.summary.pendingQuotes')} value={orders ? pendingQuotes.length : '—'} />
            <Field label={t('contacts.detail.summary.pendingTasks')} value={tasks ? pendingTasks.length : '—'} />
          </div>
        </StatCard>

        <StatCard title={t('contacts.detail.sections.details')}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('contacts.detail.fields.createdAt')} value={formatDate(contact.created_at, language)} />
            <Field label={t('contacts.detail.fields.lastContact')} value={lastContactAt ? formatDateTime(lastContactAt, language) : t('contacts.detail.fields.lastContact.none')} />
            <Field label={t('contacts.detail.fields.assignedAgent')} value={assignedAgentName ?? t('contacts.detail.fields.unassigned')} />
          </div>
        </StatCard>
      </div>

      {nextAppointment && (
        <div className="rounded-xl border border-accent-200 bg-accent-50/50 p-4">
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
                  {nextAppointment.reminder_sent_at ? t('contacts.detail.nextAppointment.reminderSent') : t('contacts.detail.nextAppointment.reminderPending')}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleAppointmentStatus(nextAppointment.id, 'completada')}>
                <CheckIcon width={13} height={13} /> {t('contacts.detail.nextAppointment.complete')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleAppointmentStatus(nextAppointment.id, 'cancelada')}>
                <XCircleIcon width={13} height={13} /> {t('contacts.detail.nextAppointment.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="actividad">{t('contacts.detail.tabs.activity')}</TabsTrigger>
          <TabsTrigger value="oportunidades">{`${t('contacts.detail.tabs.opportunities')}${opportunities ? ` (${opportunities.length})` : ''}`}</TabsTrigger>
          <TabsTrigger value="ventas">{`${t('contacts.detail.tabs.sales')}${orders ? ` (${orders.length})` : ''}`}</TabsTrigger>
          <TabsTrigger value="conversaciones">{t('contacts.detail.tabs.conversations')}</TabsTrigger>
          <TabsTrigger value="direcciones">{`${t('contacts.detail.tabs.addresses')}${addresses ? ` (${addresses.length})` : ''}`}</TabsTrigger>
        </TabsList>

        <TabsContent value="actividad">
          <Panel>
            <form onSubmit={handleAddNote} className="mb-4 rounded-xl border border-brand-100 bg-brand-50/40 p-3 focus-within:border-accent-300">
              <Textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder={t('contacts.detail.activity.notePlaceholder')}
                rows={2}
                className="!resize-none !border-0 !bg-transparent !p-0 !shadow-none focus-visible:!ring-0"
              />
              <div className="mt-2 flex justify-end">
                <Button type="submit" size="sm" disabled={savingNote || !noteDraft.trim()}>
                  <PlusIcon width={13} height={13} /> {savingNote ? t('common.actions.saving') : t('contacts.detail.activity.addNote')}
                </Button>
              </div>
            </form>

            {(!notes || !appointments) && <PageSpinner />}
            {notes && appointments && timeline.length === 0 && <p className="py-6 text-center text-sm text-brand-400">{t('contacts.detail.activity.empty')}</p>}
            {notes && appointments && timeline.length > 0 && (
              <ul>
                {timelinePage.items.map((item, idx) => (
                  <li key={`${item.kind}-${item.kind === 'appointment' ? item.appointment.id : item.note.id}`} className="relative flex gap-3 pb-4 last:pb-0">
                    {idx < timelinePage.items.length - 1 && <span aria-hidden="true" className="absolute left-3.5 top-7 bottom-0 w-px bg-brand-100" />}
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
                          <Badge variant="outline" className={APPOINTMENT_STATUS_BADGE_CLASS[item.appointment.status]}>
                            {t(APPOINTMENT_STATUS_LABEL[item.appointment.status])}
                          </Badge>
                        </div>
                      ) : (
                        <div className="flex items-start gap-1.5">
                          <p className="whitespace-pre-wrap text-sm text-brand-700">{item.note.content}</p>
                          {item.note.created_by_ai && <AiBadge />}
                        </div>
                      )}
                      {item.kind === 'appointment' && item.appointment.notes && <p className="mt-0.5 text-sm text-brand-500">{item.appointment.notes}</p>}
                      <p className="mt-1.5 text-xs text-brand-400">{formatDateTime(item.date, language)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Pagination page={page} totalPages={timelinePage.totalPages} onChange={setPage} />
          </Panel>
        </TabsContent>

        <TabsContent value="oportunidades">
          <Panel>
            {!opportunities && <PageSpinner />}
            {opportunities && opportunities.length === 0 && <p className="py-6 text-center text-sm text-brand-400">{t('contacts.detail.opportunities.empty')}</p>}
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
          </Panel>
        </TabsContent>

        <TabsContent value="ventas">
          <Panel>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-brand-400">{t('contacts.detail.sales.description')}</p>
              <Button size="sm" onClick={() => navigate(`/app/sales/new?contactId=${contact.id}`)}>
                <PlusIcon width={13} height={13} /> {t('contacts.detail.sales.new')}
              </Button>
            </div>
            {!orders && <PageSpinner />}
            {orders && orders.length === 0 && <p className="py-6 text-center text-sm text-brand-400">{t('contacts.detail.sales.empty')}</p>}
            {orders && orders.length > 0 && (
              <ul className="space-y-2">
                {ordersPage.items.map((o) => (
                  <li key={o.id}>
                    <button
                      onClick={() => navigate(`/app/sales/${o.id}`)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3 text-left transition-colors hover:bg-brand-50"
                    >
                      <span className="min-w-0">
                        <span className="font-mono text-xs font-semibold text-brand-400">ORD-{o.number}</span>
                        {o.opportunity && <span className="ml-2 truncate text-xs text-brand-400">{o.opportunity.title}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className={ORDER_STATUS_BADGE_CLASS[o.status]}>
                          {t(ORDER_STATUS_LABEL[o.status])}
                        </Badge>
                        <span className="text-sm font-semibold text-brand-700">{formatCurrency(o.total, o.currency)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Pagination page={page} totalPages={ordersPage.totalPages} onChange={setPage} />
          </Panel>
        </TabsContent>

        <TabsContent value="conversaciones">
          <Panel>
            {!conversations && <PageSpinner />}
            {conversations && conversations.length === 0 && <p className="py-6 text-center text-sm text-brand-400">{t('contacts.detail.conversations.empty')}</p>}
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
                          <span className="text-sm font-medium text-brand-800">{conv.mode === 'ia' ? t('contacts.detail.conversations.modeIa') : t('contacts.detail.conversations.modeHuman')}</span>
                          {conv.status === 'closed' && (
                            <Badge variant="outline" className="border-transparent bg-red-100 text-red-700">
                              {t('contacts.detail.conversations.closed')}
                            </Badge>
                          )}
                        </span>
                        <span className="block truncate text-xs text-brand-400">{conv.whatsapp_line?.display_name ?? t('contacts.detail.conversations.line')}</span>
                      </span>
                    </span>
                    {conv.last_message_at && <span className="text-xs text-brand-300">{formatDateTime(conv.last_message_at, language)}</span>}
                  </button>
                ))}
              </div>
            )}
            <Pagination page={page} totalPages={conversationsPage.totalPages} onChange={setPage} />
          </Panel>
        </TabsContent>

        <TabsContent value="direcciones">
          <Panel>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-brand-400">{t('contacts.detail.addresses.description')}</p>
              <Button size="sm" onClick={() => setAddressDrawer({ open: true, address: null })}>
                <PlusIcon width={13} height={13} /> {t('contacts.detail.addresses.new')}
              </Button>
            </div>
            {!addresses && <PageSpinner />}
            {addresses && addresses.length === 0 && <p className="py-6 text-center text-sm text-brand-400">{t('contacts.detail.addresses.empty')}</p>}
            {addresses && addresses.length > 0 && (
              <ul className="space-y-2">
                {addressesPage.items.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {a.label && <p className="text-sm font-semibold text-brand-800">{a.label}</p>}
                        {a.is_default && (
                          <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                            {t('contacts.detail.addresses.default')}
                          </Badge>
                        )}
                        {a.is_shipping && (
                          <Badge variant="outline" className="border-transparent bg-sky-100 text-sky-700">
                            {t('contacts.detail.addresses.shipping')}
                          </Badge>
                        )}
                        {a.is_billing && (
                          <Badge variant="outline" className="border-transparent bg-violet-100 text-violet-700">
                            {t('contacts.detail.addresses.billing')}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-brand-700">
                        {a.line1}
                        {a.line2 ? `, ${a.line2}` : ''}
                        {a.city ? `, ${a.city}` : ''}
                      </p>
                      {a.notes && <p className="mt-0.5 text-xs text-brand-400">{a.notes}</p>}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon-xs" aria-label={t('contacts.detail.addresses.aria.edit')} onClick={() => setAddressDrawer({ open: true, address: a })}>
                        <PencilIcon width={13} height={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-red-600 hover:bg-red-50"
                        aria-label={t('contacts.detail.addresses.aria.delete')}
                        onClick={() => setDeleteAddressId(a.id)}
                      >
                        <TrashIcon width={13} height={13} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Pagination page={page} totalPages={addressesPage.totalPages} onChange={setPage} />
          </Panel>
        </TabsContent>
      </Tabs>

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
        </>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteClient}
        title={t('contacts.detail.deleteConfirm.title')}
        description={t('contacts.detail.deleteConfirm.description')}
        confirmLabel={t('contacts.detail.deleteConfirm.confirmLabel')}
        loading={deleting}
        error={deleteError}
      />
    </div>
  )
}
