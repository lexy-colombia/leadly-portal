import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { Button, Card, EmptyState, IconInput, PageSpinner, Select } from '../../components/ui'
import { FilterIcon, PlusIcon, SearchIcon, XCircleIcon } from '../../components/icons'
import { conversationDisplayName, listConversations, subscribeToConversations, type ConversationWithLine } from '../../lib/api/conversations'
import { listConversationTags, listTagAssignmentsForConversations } from '../../lib/api/conversationTags'
import { listProfilesByTenant } from '../../lib/api/users'
import { listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import type { ConversationTag, Profile, WhatsappLine } from '../../types/domain'
import { ChatPanel } from './inbox/ChatPanel'
import { ConversationListItem } from './inbox/ConversationListItem'
import { NewConversationDrawer } from './inbox/NewConversationDrawer'

type QuickView = 'aiActive' | 'unassigned' | 'human' | 'myOpen' | null

export function Inbox() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [searchParams, setSearchParams] = useSearchParams()
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [lines, setLines] = useState<WhatsappLine[]>([])
  const [tags, setTags] = useState<ConversationTag[]>([])
  const [tagAssignments, setTagAssignments] = useState<Map<string, string[]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('c'))
  const [newConvOpen, setNewConvOpen] = useState(false)

  const [tab, setTab] = useState<'all' | 'mine' | 'archived'>('all')
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filterAgent, setFilterAgent] = useState('')
  const [filterStatus, setFilterStatus] = useState<'' | 'open' | 'closed'>('')
  const [filterMode, setFilterMode] = useState<'' | 'ia' | 'humano'>('')
  const [filterTag, setFilterTag] = useState('')
  const [filterLine, setFilterLine] = useState('')
  const [quickView, setQuickView] = useState<QuickView>(null)
  const filtersRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!profile?.tenant_id) return
    const tenantId = profile.tenant_id

    listConversations(tenantId)
      .then((list) => {
        setConversations(list)
        listTagAssignmentsForConversations(list.map((c) => c.id)).then(setTagAssignments).catch(() => {})
      })
      .catch((err) => setError(err.message ?? t('inbox.errors.loadConversations')))
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
    listConversationTags(tenantId).then(setTags).catch(() => {})
    listWhatsappLinesByTenant(tenantId).then(setLines).catch(() => {})

    const unsubscribe = subscribeToConversations(tenantId, () => {
      listConversations(tenantId)
        .then((list) => {
          setConversations(list)
          listTagAssignmentsForConversations(list.map((c) => c.id)).then(setTagAssignments).catch(() => {})
        })
        .catch(() => {})
    })
    return unsubscribe
  }, [profile?.tenant_id])

  // Deep-link from the contact detail screen ("Ver conversación") lands here
  // with ?c=<id> -- select it once conversations have loaded, then drop the
  // query param so it doesn't fight manual selection afterwards.
  useEffect(() => {
    const target = searchParams.get('c')
    if (target && conversations?.some((c) => c.id === target)) {
      setSelectedId(target)
      setSearchParams({}, { replace: true })
    }
  }, [conversations, searchParams, setSearchParams])

  useEffect(() => {
    if (!filtersOpen) return
    function handleClick(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [filtersOpen])

  function toggleQuickView(view: Exclude<QuickView, null>) {
    if (quickView === view) {
      setQuickView(null)
      setFilterMode('')
      setFilterAgent('')
      setFilterStatus('')
      setTab('all')
      return
    }
    setQuickView(view)
    setFilterMode('')
    setFilterAgent('')
    setFilterStatus('')
    setFilterTag('')
    setFilterLine('')
    setTab('all')
    if (view === 'aiActive') setFilterMode('ia')
    if (view === 'unassigned') setFilterAgent('unassigned')
    if (view === 'human') setFilterMode('humano')
    if (view === 'myOpen') {
      setTab('mine')
      setFilterStatus('open')
    }
  }

  const filtered = useMemo(() => {
    if (!conversations) return null
    const term = search.trim().toLowerCase()
    return conversations.filter((c) => {
      if (tab === 'archived') {
        if (!c.archived_at) return false
      } else {
        if (c.archived_at) return false
        if (tab === 'mine' && c.assigned_agent_id !== profile?.id) return false
      }
      if (filterAgent === 'unassigned' && c.assigned_agent_id) return false
      if (filterAgent && filterAgent !== 'unassigned' && c.assigned_agent_id !== filterAgent) return false
      if (filterStatus && c.status !== filterStatus) return false
      if (filterMode && c.mode !== filterMode) return false
      if (filterTag && !(tagAssignments.get(c.id) ?? []).includes(filterTag)) return false
      if (filterLine && c.whatsapp_line_id !== filterLine) return false
      if (!term) return true
      return conversationDisplayName(c).toLowerCase().includes(term) || c.contact_phone.includes(term)
    })
  }, [conversations, search, tab, filterAgent, filterStatus, filterMode, filterTag, filterLine, tagAssignments, profile?.id])

  const hasActiveFilters = !!filterAgent || !!filterStatus || !!filterMode || !!filterTag || !!filterLine

  const selected = conversations?.find((c) => c.id === selectedId) ?? null

  return (
    <div className="flex h-full min-h-[500px] flex-col">
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <div className="flex gap-1 rounded-full bg-brand-50 p-0.5">
          {(['all', 'mine', 'archived'] as const).map((value) => (
            <button
              key={value}
              onClick={() => {
                setTab(value)
                setQuickView(null)
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                tab === value ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-400 hover:text-brand-700'
              }`}
            >
              {t(value === 'all' ? 'inbox.tabs.all' : value === 'mine' ? 'inbox.tabs.mine' : 'inbox.tabs.archived')}
            </button>
          ))}
        </div>

        <div className="relative w-full max-w-[220px] sm:w-auto">
          <IconInput
            icon={<SearchIcon width={13} height={13} />}
            placeholder={t('inbox.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`!py-1.5 !pl-7 text-xs ${search ? '!pr-7' : ''}`}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('inbox.search.clear')}
              className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-brand-300 hover:text-brand-500"
            >
              <XCircleIcon width={13} height={13} />
            </button>
          )}
        </div>

        <div ref={filtersRef} className="relative">
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              hasActiveFilters ? 'border-accent-300 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-600 hover:bg-brand-50'
            }`}
          >
            <FilterIcon width={13} height={13} />
            {t('inbox.filters')}
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </button>

          {filtersOpen && (
            <div className="absolute right-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-brand-100 bg-white p-4 shadow-lg">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-brand-400">{t('inbox.filters.quickViews')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {(['aiActive', 'unassigned', 'human', 'myOpen'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => toggleQuickView(view)}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                        quickView === view ? 'border-accent-400 bg-accent-500 text-white' : 'border-brand-200 text-brand-500 hover:bg-brand-50'
                      }`}
                    >
                      {t(`inbox.views.${view}` as const)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.agent')}</label>
                <Select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)} className="!py-1.5 text-sm">
                  <option value="">{t('inbox.filters.agent.all')}</option>
                  <option value="unassigned">{t('inbox.filters.agent.unassigned')}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.full_name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.status')}</label>
                <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)} className="!py-1.5 text-sm">
                  <option value="">{t('inbox.filters.status.all')}</option>
                  <option value="open">{t('inbox.filters.status.open')}</option>
                  <option value="closed">{t('inbox.filters.status.closed')}</option>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.mode')}</label>
                <Select value={filterMode} onChange={(e) => setFilterMode(e.target.value as typeof filterMode)} className="!py-1.5 text-sm">
                  <option value="">{t('inbox.filters.mode.all')}</option>
                  <option value="ia">{t('inbox.filters.mode.ia')}</option>
                  <option value="humano">{t('inbox.filters.mode.humano')}</option>
                </Select>
              </div>
              {tags.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.tag')}</label>
                  <Select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} className="!py-1.5 text-sm">
                    <option value="">{t('inbox.filters.tag.all')}</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {lines.length > 1 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.line')}</label>
                  <Select value={filterLine} onChange={(e) => setFilterLine(e.target.value)} className="!py-1.5 text-sm">
                    <option value="">{t('inbox.filters.line.all')}</option>
                    {lines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.display_name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterAgent('')
                    setFilterStatus('')
                    setFilterMode('')
                    setFilterTag('')
                    setFilterLine('')
                    setQuickView(null)
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-700"
                >
                  {t('inbox.filters.clear')}
                </button>
              )}
            </div>
          )}
        </div>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {(filtered?.length ?? 0) === 1 ? t('inbox.count.singular') : t('inbox.count.plural')}
        </span>

        <Button variant="secondary" onClick={() => setNewConvOpen(true)} className="!ml-auto !py-1.5 !text-xs">
          <PlusIcon width={14} height={14} /> {t('inbox.newConversation')}
        </Button>
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <Card padded={false} className="flex min-h-0 flex-1 overflow-hidden">
        {!conversations && <PageSpinner />}

        {conversations && filtered && filtered.length === 0 && (
          <div className="flex-1">
            <EmptyState>{conversations.length > 0 ? t('inbox.empty.title') : t('inbox.empty.noneYet')}</EmptyState>
          </div>
        )}

        {filtered && filtered.length > 0 && (
          <div className="flex min-h-0 flex-1">
            <div
              className={`min-h-0 w-full shrink-0 overflow-y-auto border-brand-100 lg:block lg:w-80 lg:border-r ${
                selected ? 'hidden lg:block' : 'block'
              }`}
            >
              {filtered.map((conversation) => (
                <ConversationListItem
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === selectedId}
                  onClick={() => setSelectedId(conversation.id)}
                />
              ))}
            </div>

            <div className={`min-h-0 flex-1 ${selected ? 'block' : 'hidden lg:block'}`}>
              {selected ? (
                <ChatPanel conversation={selected} agents={agents} onBack={() => setSelectedId(null)} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-brand-400">{t('inbox.selectConversation')}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {profile?.tenant_id && (
        <NewConversationDrawer
          open={newConvOpen}
          onClose={() => setNewConvOpen(false)}
          tenantId={profile.tenant_id}
          onCreated={(conversationId) => {
            listConversations(profile.tenant_id!).then((list) => {
              setConversations(list)
              setSelectedId(conversationId)
            })
          }}
        />
      )}
    </div>
  )
}
