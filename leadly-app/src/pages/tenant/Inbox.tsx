import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useHeaderSearchSlot } from '@/contexts/HeaderSearchSlotContext'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, IconInput } from '@/components/molecules'
import { FilterIcon, PlusIcon, SearchIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { conversationDisplayName, listConversations, subscribeToConversations, type ConversationWithLine } from '../../lib/api/conversations'
import { listConversationTags, listTagAssignmentsForConversations } from '../../lib/api/conversationTags'
import { listProfilesByTenant } from '../../lib/api/users'
import { listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import type { ConversationTag, Profile, WhatsappLine } from '../../types/domain'
import { ChatPanel } from './inbox/ChatPanel'
import { ConversationListItem } from './inbox/ConversationListItem'
import { NewConversationDrawer } from './inbox/NewConversationDrawer'

type QuickView = 'aiActive' | 'unassigned' | 'human' | 'myOpen' | null

// shadcn Select can't take an empty string as an item value -- every "all"
// option below uses this sentinel instead, converted back to '' at the
// filter boundary.
const ALL = '__all'

export function Inbox() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const { slot: headerSearchSlot } = useHeaderSearchSlot()
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
    // AppShell gives this route (the tenant index, "/app") a bare
    // `overflow-hidden` content wrapper with no padding -- every other
    // route gets p-5/lg:p-8 for free, Inbox replicates it here itself so
    // it still has the same breathing room, but capped by `h-full` instead
    // of letting the ancestor's own scroll take over (see AppShell's
    // `isFullBleed`).
    <div className="flex h-full min-h-[500px] flex-col p-5 lg:p-8">
      {headerSearchSlot &&
        createPortal(
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('inbox.search')}
            className="!w-64 !rounded-lg !py-1.5 text-xs"
          />,
          headerSearchSlot,
        )}

      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => { setTab(v as typeof tab); setQuickView(null) }}>
          <TabsList>
            <TabsTrigger value="all" className="text-xs">
              {t('inbox.tabs.all')}
            </TabsTrigger>
            <TabsTrigger value="mine" className="text-xs">
              {t('inbox.tabs.mine')}
            </TabsTrigger>
            <TabsTrigger value="archived" className="text-xs">
              {t('inbox.tabs.archived')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div ref={filtersRef} className="relative">
          <Button type="button" variant={hasActiveFilters ? 'secondary' : 'outline'} size="sm" onClick={() => setFiltersOpen((o) => !o)}>
            <FilterIcon width={13} height={13} />
            {t('inbox.filters')}
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </Button>

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
                <Select value={filterAgent || ALL} onValueChange={(v) => setFilterAgent(v === ALL ? '' : v)}>
                  <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL} className="text-xs">
                      {t('inbox.filters.agent.all')}
                    </SelectItem>
                    <SelectItem value="unassigned" className="text-xs">
                      {t('inbox.filters.agent.unassigned')}
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id} className="text-xs">
                        {a.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.status')}</label>
                <Select value={filterStatus || ALL} onValueChange={(v) => setFilterStatus(v === ALL ? '' : (v as 'open' | 'closed'))}>
                  <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL} className="text-xs">
                      {t('inbox.filters.status.all')}
                    </SelectItem>
                    <SelectItem value="open" className="text-xs">
                      {t('inbox.filters.status.open')}
                    </SelectItem>
                    <SelectItem value="closed" className="text-xs">
                      {t('inbox.filters.status.closed')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.mode')}</label>
                <Select value={filterMode || ALL} onValueChange={(v) => setFilterMode(v === ALL ? '' : (v as 'ia' | 'humano'))}>
                  <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL} className="text-xs">
                      {t('inbox.filters.mode.all')}
                    </SelectItem>
                    <SelectItem value="ia" className="text-xs">
                      {t('inbox.filters.mode.ia')}
                    </SelectItem>
                    <SelectItem value="humano" className="text-xs">
                      {t('inbox.filters.mode.humano')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {tags.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.tag')}</label>
                  <Select value={filterTag || ALL} onValueChange={(v) => setFilterTag(v === ALL ? '' : v)}>
                    <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL} className="text-xs">
                        {t('inbox.filters.tag.all')}
                      </SelectItem>
                      {tags.map((tagItem) => (
                        <SelectItem key={tagItem.id} value={tagItem.id} className="text-xs">
                          {tagItem.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {lines.length > 1 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('inbox.filters.line')}</label>
                  <Select value={filterLine || ALL} onValueChange={(v) => setFilterLine(v === ALL ? '' : v)}>
                    <SelectTrigger className="w-full !h-7 !rounded-lg !text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL} className="text-xs">
                        {t('inbox.filters.line.all')}
                      </SelectItem>
                      {lines.map((line) => (
                        <SelectItem key={line.id} value={line.id} className="text-xs">
                          {line.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
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

        <Button onClick={() => setNewConvOpen(true)} size="sm" className="ml-auto">
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
