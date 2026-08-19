import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language, TranslationKey } from '../../i18n/translations'
import { deleteWhatsappLine, listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import { getMaxWhatsappLinesForTenant } from '../../lib/api/billing'
import { assignAiAssistantToLine, deleteAiAssistant, listAiAssistantsByTenant } from '../../lib/api/aiAssistants'
import { listConversations, type ConversationWithLine } from '../../lib/api/conversations'
import type { AiAssistant, AiProvider, WhatsappLine, WhatsappLineStatus } from '../../types/domain'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { EmptyState } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AiSparkleIcon, ChatBubbleIcon, FileIcon, PencilIcon, PhoneIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { AiAssistantDrawer } from './AiAssistantDrawer'
import { TemplatesSection } from './TemplatesSection'

const LINE_STATUS_KEY: Record<WhatsappLineStatus, TranslationKey> = {
  pending_verification: 'settings.lines.status.pendingVerification',
  active: 'settings.lines.status.active',
  suspended: 'settings.lines.status.suspended',
  disconnected: 'settings.lines.status.disconnected',
}

const LINE_STATUS_BADGE_CLASS: Record<WhatsappLineStatus, string> = {
  pending_verification: 'border-transparent bg-amber-100 text-amber-700',
  active: 'border-transparent bg-emerald-100 text-emerald-700',
  suspended: 'border-transparent bg-red-100 text-red-700',
  disconnected: 'border-transparent bg-slate-100 text-slate-600',
}

const PROVIDER_KEY: Record<AiProvider, TranslationKey> = {
  openai: 'settings.assistant.provider.openai',
  gemini: 'settings.assistant.provider.gemini',
}

// shadcn Select can't take an empty string as an item value.
const NONE = '__none'

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString()
}

function formatActivity(iso: string | undefined, language: Language, noActivityLabel: string): string {
  if (!iso) return noActivityLabel
  const date = new Date(iso)
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return isToday(iso) ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
}

function MetricCard({ icon, iconClass, value, label, sublabel }: { icon: ReactNode; iconClass: string; value: string; label: string; sublabel?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-brand-100 bg-white p-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${iconClass}`}>{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-lg font-bold text-brand-800">{value}</p>
        <p className="truncate text-xs text-brand-500">{label}</p>
        {sublabel && <p className="truncate text-[11px] text-brand-300">{sublabel}</p>}
      </div>
    </div>
  )
}

/** Shared by the tenant's "IA & Agentes" screen and the backoffice's Cliente
 * "Líneas de WhatsApp" tab -- same two-section shape (Líneas / Agentes) in
 * both places instead of the backoffice's old single mixed table, where a
 * line's "Asistente de IA" button only worked if it already had one
 * assigned (no way to assign a new agent from there at all). Line creation
 * differs per context (backoffice provisions manually via a drawer with
 * Meta credentials; the tenant self-connects via Embedded Signup), so
 * that part is injected -- exactly one of `renderLineDrawer`/`connectLine`
 * should be passed. */
export function LinesAndAgentsSection({
  tenantId,
  canManage,
  manageSkills = false,
  showMetrics = true,
  renderLineDrawer,
  connectLine,
}: {
  tenantId: string
  /** Whether the current viewer can delete lines/agents (tenant: only
   * tenant_admin; backoffice: always, superadmin-only screen already). */
  canManage: boolean
  /** Only the backoffice passes this through to AiAssistantDrawer. */
  manageSkills?: boolean
  showMetrics?: boolean
  /** Backoffice: renders WhatsappLineDrawer for manual create/edit -- rows
   * become clickable and "Nueva línea" opens it with `line: null`. */
  renderLineDrawer?: (props: { open: boolean; line: WhatsappLine | null; onClose: () => void; onSaved: () => void }) => ReactNode
  /** Tenant: Embedded Signup self-service connect instead of a manual drawer. */
  connectLine?: { label: string; loading: boolean; onClick: () => void }
}) {
  const { t, language } = useLanguage()
  const [tab, setTab] = useState<'lineas' | 'agentes' | 'plantillas'>('lineas')
  const [lines, setLines] = useState<WhatsappLine[] | null>(null)
  const [assistants, setAssistants] = useState<AiAssistant[] | null>(null)
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentDrawer, setAgentDrawer] = useState<{ open: boolean; assistantId: string | null }>({ open: false, assistantId: null })
  const [lineDrawerState, setLineDrawerState] = useState<{ open: boolean; line: WhatsappLine | null }>({ open: false, line: null })
  const [confirmingDeleteLineId, setConfirmingDeleteLineId] = useState<string | null>(null)
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null)
  const [deleteLineError, setDeleteLineError] = useState<string | null>(null)
  const [confirmingDeleteAgentId, setConfirmingDeleteAgentId] = useState<string | null>(null)
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null)
  const [assigningLineId, setAssigningLineId] = useState<string | null>(null)
  const [maxLines, setMaxLines] = useState<number | null>(null)

  function reload() {
    listWhatsappLinesByTenant(tenantId).then(setLines).catch((err) => setError(err.message ?? t('settings.lines.errors.loadLines')))
    listAiAssistantsByTenant(tenantId)
      .then(setAssistants)
      .catch((err) => setError(err.message ?? t('settings.lines.errors.loadAgents')))
    listConversations(tenantId)
      .then(setConversations)
      .catch(() => setConversations([]))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [tenantId])
  useEffect(() => {
    getMaxWhatsappLinesForTenant(tenantId)
      .then(setMaxLines)
      .catch(() => setMaxLines(null))
  }, [tenantId])

  const lastActivityByLine = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of conversations ?? []) {
      if (!c.last_message_at) continue
      const current = map.get(c.whatsapp_line_id)
      if (!current || c.last_message_at > current) map.set(c.whatsapp_line_id, c.last_message_at)
    }
    return map
  }, [conversations])

  function agentUsageCount(assistantId: string): number {
    return (lines ?? []).filter((l) => l.ai_assistant_id === assistantId).length
  }

  const connectedLines = (lines ?? []).filter((l) => l.status === 'active').length
  const linesWithAgent = (lines ?? []).filter((l) => l.ai_assistant_id).length
  const conversationsToday = (conversations ?? []).filter((c) => c.last_message_at && isToday(c.last_message_at)).length
  const activeAgents = (assistants ?? []).filter((a) => a.is_active).length
  const atLineCapacity = maxLines !== null && connectedLines >= maxLines

  async function handleDeleteLine(lineId: string) {
    setDeletingLineId(lineId)
    setDeleteLineError(null)
    try {
      await deleteWhatsappLine(lineId)
      setConfirmingDeleteLineId(null)
      reload()
    } catch (err) {
      setDeleteLineError(err instanceof Error ? err.message : t('settings.lines.errors.deleteLine'))
    } finally {
      setDeletingLineId(null)
    }
  }

  async function handleDeleteAgent(assistantId: string) {
    setDeletingAgentId(assistantId)
    setDeleteAgentError(null)
    try {
      await deleteAiAssistant(assistantId)
      setConfirmingDeleteAgentId(null)
      reload()
    } catch (err) {
      setDeleteAgentError(err instanceof Error ? err.message : t('settings.lines.errors.deleteAgent'))
    } finally {
      setDeletingAgentId(null)
    }
  }

  async function handleAssign(lineId: string, assistantId: string) {
    setAssigningLineId(lineId)
    setLines((prev) => (prev ? prev.map((l) => (l.id === lineId ? { ...l, ai_assistant_id: assistantId || null } : l)) : prev))
    try {
      await assignAiAssistantToLine(lineId, assistantId || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.lines.errors.assignAgent'))
      reload()
    } finally {
      setAssigningLineId(null)
    }
  }

  return (
    <div className="space-y-3.5">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="lineas" className="text-xs">
              <PhoneIcon width={13} height={13} /> {t('settings.lines.tabs.lines')}
            </TabsTrigger>
            <TabsTrigger value="agentes" className="text-xs">
              <AiSparkleIcon width={13} height={13} /> {t('settings.lines.tabs.agents')}
            </TabsTrigger>
            <TabsTrigger value="plantillas" className="text-xs">
              <FileIcon width={13} height={13} /> {t('settings.templates.tabs.templates')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {tab !== 'plantillas' &&
          canManage &&
          (tab === 'lineas' ? (
            connectLine ? (
              <Button
                onClick={connectLine.onClick}
                disabled={connectLine.loading || atLineCapacity}
                title={atLineCapacity ? t('settings.lines.metrics.atCapacity', { max: maxLines ?? 0 }) : undefined}
                size="sm"
              >
                <PlusIcon width={14} height={14} /> {connectLine.loading ? t('settings.lines.connecting') : connectLine.label}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setLineDrawerState({ open: true, line: null })}>
                <PlusIcon width={14} height={14} /> {t('settings.lines.newLine')}
              </Button>
            )
          ) : (
            <Button size="sm" onClick={() => setAgentDrawer({ open: true, assistantId: null })}>
              <PlusIcon width={14} height={14} /> {t('settings.lines.newAgent')}
            </Button>
          ))}
      </div>

      {showMetrics && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <MetricCard
            icon={<PhoneIcon width={16} height={16} />}
            iconClass="bg-emerald-50 text-emerald-600"
            value={maxLines !== null ? `${connectedLines}/${maxLines}` : String(connectedLines)}
            label={t('settings.lines.metrics.connectedLines')}
            sublabel={lines ? t('settings.lines.metrics.totalCount', { count: lines.length }) : undefined}
          />
          <MetricCard
            icon={<AiSparkleIcon width={16} height={16} />}
            iconClass="bg-violet-50 text-violet-600"
            value={String(linesWithAgent)}
            label={t('settings.lines.metrics.withAgent')}
            sublabel={
              lines && lines.length > 0
                ? t('settings.lines.metrics.percentOfLines', { percent: Math.round((linesWithAgent / lines.length) * 100) })
                : undefined
            }
          />
          <MetricCard
            icon={<ChatBubbleIcon width={16} height={16} />}
            iconClass="bg-sky-50 text-sky-600"
            value={String(conversationsToday)}
            label={t('settings.lines.metrics.conversationsToday')}
          />
          <MetricCard
            icon={<AiSparkleIcon width={16} height={16} />}
            iconClass="bg-amber-50 text-amber-600"
            value={String(activeAgents)}
            label={t('settings.lines.metrics.activeAgents')}
            sublabel={assistants ? t('settings.lines.metrics.totalCount', { count: assistants.length }) : undefined}
          />
        </div>
      )}

      {tab === 'lineas' && (
        <>
          {!lines && !error && <PageSpinner />}
          {lines && lines.length === 0 && (
            <EmptyState>{connectLine ? t('settings.lines.emptyTenant') : t('settings.lines.emptyBackoffice')}</EmptyState>
          )}
          {lines && lines.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('settings.lines.table.line')}</TableHead>
                    <TableHead>{t('settings.lines.table.status')}</TableHead>
                    <TableHead>{t('settings.lines.table.assignedAgent')}</TableHead>
                    <TableHead>{t('settings.lines.table.lastActivity')}</TableHead>
                    <TableHead className="text-right">{t('settings.lines.table.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const assignedAgent = assistants?.find((a) => a.id === line.ai_assistant_id)
                    const clickable = !!renderLineDrawer
                    return (
                      <TableRow key={line.id}>
                        <TableCell className={clickable ? 'cursor-pointer' : undefined} onClick={clickable ? () => setLineDrawerState({ open: true, line }) : undefined}>
                          <span className="flex items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                              <PhoneIcon width={14} height={14} />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-medium text-brand-800">{line.display_name}</span>
                              {line.display_phone_number && <span className="block truncate text-xs text-brand-400">{line.display_phone_number}</span>}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={LINE_STATUS_BADGE_CLASS[line.status]}>
                            {t(LINE_STATUS_KEY[line.status])}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {assignedAgent && <InitialsAvatar name={assignedAgent.name} size="xs" />}
                            <Select
                              value={line.ai_assistant_id ?? NONE}
                              disabled={!assistants || assigningLineId === line.id || line.status === 'disconnected'}
                              onValueChange={(v) => handleAssign(line.id, v === NONE ? '' : v)}
                            >
                              <SelectTrigger className="!h-7 w-auto !rounded-lg !text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NONE} className="text-xs">
                                  {t('settings.lines.table.noAgentOption')}
                                </SelectItem>
                                {(assistants ?? []).map((agent) => (
                                  <SelectItem key={agent.id} value={agent.id} className="text-xs">
                                    {agent.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-brand-400">{formatActivity(lastActivityByLine.get(line.id), language, t('settings.lines.noActivity'))}</TableCell>
                        <TableCell className="text-right">
                          {canManage && line.status !== 'disconnected' && (
                            <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingDeleteLineId(line.id)}>
                              <TrashIcon width={13} height={13} />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {lines && lines.length > 0 && (
            <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-brand-400">
              <span>{t('settings.lines.footerNote')}</span>
              <span>{t('settings.lines.showingCount', { shown: lines.length, total: lines.length })}</span>
            </p>
          )}
        </>
      )}

      {tab === 'agentes' && (
        <>
          {!assistants && !error && <PageSpinner />}
          {assistants && assistants.length === 0 && <EmptyState>{t('settings.lines.agentsEmpty')}</EmptyState>}
          {assistants && assistants.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('settings.lines.agentTable.agent')}</TableHead>
                    <TableHead>{t('settings.lines.agentTable.model')}</TableHead>
                    <TableHead>{t('settings.lines.agentTable.status')}</TableHead>
                    <TableHead>{t('settings.lines.agentTable.assignedLines')}</TableHead>
                    <TableHead className="text-right">{t('settings.lines.agentTable.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assistants.map((agent) => {
                    const usage = agentUsageCount(agent.id)
                    return (
                      <TableRow key={agent.id}>
                        <TableCell>
                          <span className="flex items-center gap-3">
                            <InitialsAvatar name={agent.name} size="sm" />
                            <span className="text-xs font-medium text-brand-800">{agent.name}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-brand-500">
                          {t(PROVIDER_KEY[agent.provider])} · {agent.model}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={agent.is_active ? 'border-transparent bg-emerald-100 text-emerald-700' : 'border-transparent bg-slate-100 text-slate-600'}>
                            {t(agent.is_active ? 'common.status.active' : 'common.status.inactive')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-brand-500">
                          {usage === 0 ? t('settings.lines.agentTable.noLines') : t(usage === 1 ? 'settings.lines.agentTable.linesOne' : 'settings.lines.agentTable.linesOther', { count: usage })}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon-xs" onClick={() => setAgentDrawer({ open: true, assistantId: agent.id })}>
                              <PencilIcon width={13} height={13} />
                            </Button>
                            {canManage && (
                              <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingDeleteAgentId(agent.id)}>
                                <TrashIcon width={13} height={13} />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {tab === 'plantillas' && <TemplatesSection tenantId={tenantId} canManage={canManage} />}

      <AiAssistantDrawer
        open={agentDrawer.open}
        onClose={() => {
          setAgentDrawer({ open: false, assistantId: null })
          reload()
        }}
        tenantId={tenantId}
        assistantId={agentDrawer.assistantId}
        manageSkills={manageSkills}
      />

      {renderLineDrawer &&
        renderLineDrawer({
          open: lineDrawerState.open,
          line: lineDrawerState.line,
          onClose: () => setLineDrawerState({ open: false, line: null }),
          onSaved: () => {
            setLineDrawerState({ open: false, line: null })
            reload()
          },
        })}

      <ConfirmDialog
        open={!!confirmingDeleteLineId}
        onClose={() => {
          setConfirmingDeleteLineId(null)
          setDeleteLineError(null)
        }}
        onConfirm={() => confirmingDeleteLineId && handleDeleteLine(confirmingDeleteLineId)}
        loading={!!deletingLineId}
        error={deleteLineError}
        title={t('settings.lines.deleteLine.title')}
        description={t('settings.lines.deleteLine.description', { name: lines?.find((l) => l.id === confirmingDeleteLineId)?.display_name ?? '' })}
        confirmLabel={t('settings.lines.deleteLine.confirm')}
      />

      <ConfirmDialog
        open={!!confirmingDeleteAgentId}
        onClose={() => {
          setConfirmingDeleteAgentId(null)
          setDeleteAgentError(null)
        }}
        onConfirm={() => confirmingDeleteAgentId && handleDeleteAgent(confirmingDeleteAgentId)}
        loading={!!deletingAgentId}
        error={deleteAgentError}
        title={t('settings.lines.deleteAgent.title')}
        description={t('settings.lines.deleteAgent.description', { name: assistants?.find((a) => a.id === confirmingDeleteAgentId)?.name ?? '' })}
        confirmLabel={t('common.actions.delete')}
      />
    </div>
  )
}
