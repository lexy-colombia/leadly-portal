import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'
import { deleteContact, listContacts } from '../../lib/api/contacts'
import { listLastContactTimesByTenant } from '../../lib/api/conversations'
import { listProfilesByTenant } from '../../lib/api/users'
import type { ContactStage, Client, Profile } from '../../types/domain'
import { Badge, Button, InitialsAvatar, PageSpinner, Select, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { FilterIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/atoms/icons'
import { ContactDrawer, STAGE_LABEL } from './clients/ContactDrawer'

const PAGE_SIZE = 8

const STAGE_TONE: Record<ContactStage, 'neutral' | 'success' | 'warning' | 'danger'> = {
  lead: 'neutral',
  contactado: 'warning',
  negociacion: 'warning',
  cliente: 'success',
  perdido: 'danger',
}

function formatLastContact(iso: string | undefined, language: Language): string {
  if (!iso) return '-'
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
}

export function Clients() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<Client[] | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [lastContact, setLastContact] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<ContactStage | ''>('')
  const [tagFilter, setTagFilter] = useState('')
  const [agentFilter, setAgentFilter] = useState('')
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [drawer, setDrawer] = useState<{ open: boolean; contact: Client | null }>({ open: false, contact: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const filtersRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!profile?.tenant_id) return
    const tenantId = profile.tenant_id
    listContacts(tenantId)
      .then(setContacts)
      .catch((err) => setError(err.message ?? t('contacts.errors.load')))
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
    listLastContactTimesByTenant(tenantId).then(setLastContact).catch(() => {})
  }, [profile?.tenant_id])

  useEffect(() => {
    if (!filtersOpen) return
    function handleClick(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [filtersOpen])

  const allTags = useMemo(() => {
    if (!contacts) return []
    return Array.from(new Set(contacts.flatMap((c) => c.tags))).sort()
  }, [contacts])

  const filtered = useMemo(() => {
    if (!contacts) return null
    const term = search.trim().toLowerCase()
    return contacts.filter((c) => {
      if (stageFilter && c.stage !== stageFilter) return false
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
  }, [contacts, search, stageFilter, tagFilter, agentFilter])

  useEffect(() => {
    setPage(1)
  }, [search, stageFilter, tagFilter, agentFilter])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  const hasActiveFilters = !!search || !!stageFilter || !!tagFilter || !!agentFilter

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteContact(id)
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
      <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">{t('contacts.title')}</h1>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full max-w-[220px] sm:w-auto">
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            placeholder={t('contacts.search.placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="!py-1.5 !pl-8 text-sm"
          />
        </div>

        <div ref={filtersRef} className="relative">
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              hasActiveFilters ? 'border-accent-300 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-600 hover:bg-brand-50'
            }`}
          >
            <FilterIcon width={14} height={14} />
            {t('contacts.filters.label')}
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </button>

          {filtersOpen && (
            <div className="absolute left-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-brand-100 bg-white p-4 shadow-lg">
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('contacts.filters.stage.label')}</label>
                <Select value={stageFilter} onChange={(e) => setStageFilter(e.target.value as ContactStage | '')} className="!py-1.5 text-sm">
                  <option value="">{t('contacts.filters.stage.all')}</option>
                  {(Object.keys(STAGE_LABEL) as ContactStage[]).map((s) => (
                    <option key={s} value={s}>
                      {t(STAGE_LABEL[s])}
                    </option>
                  ))}
                </Select>
              </div>
              {agents.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('contacts.filters.agent.label')}</label>
                  <Select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="!py-1.5 text-sm">
                    <option value="">{t('contacts.filters.agent.all')}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.full_name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {allTags.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('contacts.filters.tag.label')}</label>
                  <Select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="!py-1.5 text-sm">
                    <option value="">{t('contacts.filters.tag.all')}</option>
                    {allTags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('')
                    setStageFilter('')
                    setTagFilter('')
                    setAgentFilter('')
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-700"
                >
                  {t('contacts.filters.clear')}
                </button>
              )}
            </div>
          )}
        </div>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {t((filtered?.length ?? 0) === 1 ? 'contacts.count.singular' : 'contacts.count.plural')}
        </span>

        <Button variant="secondary" onClick={() => setDrawer({ open: true, contact: null })} className="!ml-auto !py-1.5 !text-sm">
          <PlusIcon width={16} height={16} /> {t('contacts.actions.new')}
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
          <Table>
            <THead>
              <tr>
                <TH>{t('contacts.table.contact')}</TH>
                <TH>{t('contacts.table.phone')}</TH>
                <TH>{t('contacts.table.stage')}</TH>
                <TH>{t('contacts.table.agent')}</TH>
                <TH>{t('contacts.table.lastContact')}</TH>
                <TH className="text-right">{t('contacts.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((contact) => (
                <TRow key={contact.id} onClick={() => navigate(`/app/clientes/${contact.id}`)} clickable>
                  <TD className="font-medium text-brand-800">
                    <span className="flex items-center gap-3">
                      <InitialsAvatar name={contact.full_name} size="sm" />
                      <span>
                        {contact.full_name}
                        {contact.company && <span className="block text-xs font-normal text-brand-400">{contact.company}</span>}
                      </span>
                    </span>
                  </TD>
                  <TD>{contact.phone}</TD>
                  <TD>
                    <Badge tone={STAGE_TONE[contact.stage]}>{t(STAGE_LABEL[contact.stage])}</Badge>
                  </TD>
                  <TD className="text-brand-500">{agents.find((a) => a.id === contact.assigned_to)?.full_name ?? '-'}</TD>
                  <TD className="text-brand-500">{formatLastContact(lastContact.get(contact.id), language)}</TD>
                  <TD className="text-right" onClick={(e) => e.stopPropagation()}>
                    {deletingId === contact.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(contact.id)} disabled={deleting} className="!px-2.5 !py-1.5 text-xs">
                          {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2.5 !py-1.5 text-xs">
                          {t('common.actions.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => setDrawer({ open: true, contact })}
                          className="!px-2.5 !py-1.5 text-xs"
                          aria-label={t('contacts.table.aria.edit')}
                        >
                          <PencilIcon width={13} height={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setDeletingId(contact.id)}
                          className="!px-2.5 !py-1.5 text-xs !text-red-600 hover:!bg-red-50"
                          aria-label={t('contacts.table.aria.delete')}
                        >
                          <TrashIcon width={13} height={13} />
                        </Button>
                      </span>
                    )}
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
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
