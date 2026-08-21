import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useHeaderSearchSlot } from '@/contexts/HeaderSearchSlotContext'
import type { Language } from '../../i18n/translations'
import { formatDate } from '../../lib/dates'
import { deleteClient, listClients } from '../../lib/api/clients'
import { listLastContactTimesByTenant } from '../../lib/api/conversations'
import { listProfilesByTenant } from '../../lib/api/users'
import type { ClientStage, Client, Profile } from '../../types/domain'
import { PageSpinner, InitialsAvatar } from '@/components/atoms'
import { Card, ComboboxFilter, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ContactDrawer, STAGE_LABEL } from './clients/ContactDrawer'

const PAGE_SIZE = 8

// Same trigger sizing convention as Products.tsx's filter pills, so this
// list doesn't feel like a separate design system from the rest of the app.
const FILTER_TRIGGER_CLASS = 'w-40 rounded-lg text-xs'

// bg/text pair on top of shadcn Badge's `outline` variant -- shadcn's own
// variants (default/secondary/destructive/outline/ghost) have no "warning"/
// "success" tone, unlike the legacy atoms Badge this replaces.
const STAGE_BADGE_CLASS: Record<ClientStage, string> = {
  lead: 'border-transparent bg-slate-100 text-slate-600',
  contactado: 'border-transparent bg-amber-100 text-amber-700',
  negociacion: 'border-transparent bg-amber-100 text-amber-700',
  cliente: 'border-transparent bg-emerald-100 text-emerald-700',
  perdido: 'border-transparent bg-red-100 text-red-700',
}

function formatLastContact(iso: string | undefined, language: Language): string {
  if (!iso) return '-'
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : formatDate(iso)
}

export function Clients() {
  const { profile, enabledModules } = useAuth()
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const { slot: headerSearchSlot } = useHeaderSearchSlot()
  // "Etapa" is the client-side pipeline concept (lead/contactado/.../perdido)
  // -- only worth a column/filter when the tenant actually has the Pipeline
  // module enabled (see lib/modules.ts). Without it, every row would show
  // the same meaningless default and the filter would have nothing real to
  // filter by (explicit user call: a column nobody can act on is clutter,
  // not information).
  const showStage = enabledModules?.has('pipeline') ?? false

  const [contacts, setContacts] = useState<Client[] | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [lastContact, setLastContact] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<ClientStage | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; contact: Client | null }>({ open: false, contact: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!profile?.tenant_id) return
    const tenantId = profile.tenant_id
    listClients(tenantId)
      .then(setContacts)
      .catch((err) => setError(err.message ?? t('contacts.errors.load')))
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
    listLastContactTimesByTenant(tenantId).then(setLastContact).catch(() => {})
  }, [profile?.tenant_id])

  const allTags = useMemo(() => {
    if (!contacts) return []
    return Array.from(new Set(contacts.flatMap((c) => c.tags))).sort()
  }, [contacts])

  const filtered = useMemo(() => {
    if (!contacts) return null
    const term = search.trim().toLowerCase()
    return contacts.filter((c) => {
      if (showStage && stageFilter && c.stage !== stageFilter) return false
      if (tagFilter && !c.tags.includes(tagFilter)) return false
      if (agentFilter && c.assigned_to !== agentFilter) return false
      if (!term) return true
      return (
        c.full_name.toLowerCase().includes(term) ||
        c.phone.includes(term) ||
        c.company?.toLowerCase().includes(term) ||
        c.city?.toLowerCase().includes(term) ||
        c.tags.some((tag) => tag.toLowerCase().includes(term))
      )
    })
  }, [contacts, search, showStage, stageFilter, tagFilter, agentFilter])

  useEffect(() => {
    setPage(1)
  }, [search, stageFilter, tagFilter, agentFilter])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteClient(id)
      setContacts((prev) => (prev ? prev.filter((c) => c.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('contacts.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  if (!profile?.tenant_id) return <PageSpinner />

  return (
    <div className="animate-fade-in space-y-3">
      {headerSearchSlot &&
        createPortal(
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('contacts.search.placeholder')}
            className="!w-64 !rounded-lg !py-1.5 text-xs"
          />,
          headerSearchSlot,
        )}

      <div className="flex flex-wrap items-center gap-2">
        {showStage && (
          <ComboboxFilter
            options={(Object.keys(STAGE_LABEL) as ClientStage[]).map((s) => ({ id: s, label: t(STAGE_LABEL[s]) }))}
            value={stageFilter}
            onChange={(id) => setStageFilter(id as ClientStage | null)}
            placeholder={t('contacts.filters.stage.all')}
            searchPlaceholder={t('contacts.filters.stage.search')}
            emptyLabel={t('contacts.filters.stage.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        )}

        {agents.length > 0 && (
          <ComboboxFilter
            options={agents.map((a) => ({ id: a.id, label: a.full_name }))}
            value={agentFilter}
            onChange={setAgentFilter}
            placeholder={t('contacts.filters.agent.all')}
            searchPlaceholder={t('contacts.filters.agent.search')}
            emptyLabel={t('contacts.filters.agent.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        )}

        {allTags.length > 0 && (
          <ComboboxFilter
            options={allTags.map((tag) => ({ id: tag, label: tag }))}
            value={tagFilter}
            onChange={setTagFilter}
            placeholder={t('contacts.filters.tag.all')}
            searchPlaceholder={t('contacts.filters.tag.search')}
            emptyLabel={t('contacts.filters.tag.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        )}

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {t((filtered?.length ?? 0) === 1 ? 'contacts.count.singular' : 'contacts.count.plural')}
        </span>

        <Button onClick={() => setDrawer({ open: true, contact: null })} size="sm" className="ml-auto">
          <PlusIcon width={14} height={14} /> {t('contacts.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!contacts && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>
            {contacts && contacts.length > 0 ? t('contacts.emptyState.noMatch') : t('contacts.emptyState.none')}
          </EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('contacts.table.contact')}</TableHead>
                  <TableHead>{t('contacts.table.phone')}</TableHead>
                  {showStage && <TableHead>{t('contacts.table.stage')}</TableHead>}
                  <TableHead>{t('contacts.table.agent')}</TableHead>
                  <TableHead>{t('contacts.table.lastContact')}</TableHead>
                  <TableHead className="text-right">{t('contacts.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((contact) => (
                  <TableRow key={contact.id} onClick={() => navigate(`/app/clients/${contact.id}`)} className="cursor-pointer">
                    <TableCell className="text-xs font-medium text-brand-800">
                      <span className="flex items-center gap-3">
                        <InitialsAvatar name={contact.full_name} size="sm" />
                        <span>
                          {contact.full_name}
                          {contact.company && <span className="block text-[11px] font-normal text-brand-400">{contact.company}</span>}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-brand-700">{contact.phone}</TableCell>
                    {showStage && (
                      <TableCell>
                        <Badge variant="outline" className={STAGE_BADGE_CLASS[contact.stage]}>
                          {t(STAGE_LABEL[contact.stage])}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell className="text-xs text-brand-500">{agents.find((a) => a.id === contact.assigned_to)?.full_name ?? '-'}</TableCell>
                    <TableCell className="text-xs text-brand-500">{formatLastContact(lastContact.get(contact.id), language)}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {deletingId === contact.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="destructive" size="xs" onClick={() => handleDelete(contact.id)} disabled={deleting}>
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" aria-label={t('contacts.table.aria.edit')} onClick={() => setDrawer({ open: true, contact })}>
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="text-red-600 hover:bg-red-50"
                            aria-label={t('contacts.table.aria.delete')}
                            onClick={() => setDeletingId(contact.id)}
                          >
                            <TrashIcon width={12} height={12} />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <ContactDrawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, contact: null })}
        tenantId={profile.tenant_id}
        contact={drawer.contact}
        onSaved={(c) =>
          setContacts((prev) => {
            if (!prev) return [c]
            return prev.some((p) => p.id === c.id) ? prev.map((p) => (p.id === c.id ? c : p)) : [c, ...prev]
          })
        }
      />
    </div>
  )
}
