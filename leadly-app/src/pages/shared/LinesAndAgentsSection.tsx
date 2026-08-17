import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language, TranslationKey } from '../../i18n/translations'
import { deleteWhatsappLine, listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import { getMaxWhatsappLinesForTenant } from '../../lib/api/billing'
import { assignAiAssistantToLine, deleteAiAssistant, listAiAssistantsByTenant } from '../../lib/api/aiAssistants'
import { listConversations, type ConversationWithLine } from '../../lib/api/conversations'
import type { AiAssistant, AiProvider, WhatsappLine, WhatsappLineStatus } from '../../types/domain'
import { Badge, Button, InitialsAvatar, PageSpinner, Select, TBody, TD, TH, THead, Table, TRow } from '@/components/atoms'
import { EmptyState } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { AiSparkleIcon, ChatBubbleIcon, PencilIcon, PhoneIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { AiAssistantDrawer } from './AiAssistantDrawer'

const LINE_STATUS_KEY: Record<WhatsappLineStatus, TranslationKey> = {
  pending_verification: 'settings.lines.status.pendingVerification',
  active: 'settings.lines.status.active',
  suspended: 'settings.lines.status.suspended',
  disconnected: 'settings.lines.status.disconnected',
}

const LINE_STATUS_TONE: Record<WhatsappLineStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending_verification: 'warning',
  active: 'success',
  suspended: 'danger',
  disconnected: 'neutral',
}

const PROVIDER_KEY: Record<AiProvider, TranslationKey> = {
  openai: 'settings.assistant.provider.openai',
  gemini: 'settings.assistant.provider.gemini',
}

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
  const [tab, setTab] = useState<'lineas' | 'agentes'>('lineas')
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
        <div className="flex gap-1 border-b border-brand-100">
          {(
            [
              ['lineas', t('settings.lines.tabs.lines'), PhoneIcon],
              ['agentes', t('settings.lines.tabs.agents'), AiSparkleIcon],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === value ? 'border-accent-500 text-accent-700' : 'border-transparent text-brand-400 hover:text-brand-700'
              }`}
            >
              <Icon width={15} height={15} /> {label}
            </button>
          ))}
        </div>

        {canManage &&
          (tab === 'lineas' ? (
            connectLine ? (
              <Button
                variant="primary"
                onClick={connectLine.onClick}
                disabled={connectLine.loading || atLineCapacity}
                title={atLineCapacity ? t('settings.lines.metrics.atCapacity', { max: maxLines ?? 0 }) : undefined}
                className="!py-1.5 text-xs"
              >
                <PlusIcon width={14} height={14} /> {connectLine.loading ? t('settings.lines.connecting') : connectLine.label}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setLineDrawerState({ open: true, line: null })} className="!py-1.5 text-xs">
                <PlusIcon width={14} height={14} /> {t('settings.lines.newLine')}
              </Button>
            )
          ) : (
            <Button variant="primary" onClick={() => setAgentDrawer({ open: true, assistantId: null })} className="!py-1.5 text-xs">
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
            <Table>
              <THead>
                <tr>
                  <TH>{t('settings.lines.table.line')}</TH>
                  <TH>{t('settings.lines.table.status')}</TH>
                  <TH>{t('settings.lines.table.assignedAgent')}</TH>
                  <TH>{t('settings.lines.table.lastActivity')}</TH>
                  <TH className="text-right">{t('settings.lines.table.actions')}</TH>
                </tr>
              </THead>
              <TBody>
                {lines.map((line) => {
                  const assignedAgent = assistants?.find((a) => a.id === line.ai_assistant_id)
                  const clickable = !!renderLineDrawer
                  return (
                    <TRow key={line.id}>
                      <TD className={clickable ? 'cursor-pointer' : undefined} onClick={clickable ? () => setLineDrawerState({ open: true, line }) : undefined}>
                        <span className="flex items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                            <PhoneIcon width={14} height={14} />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-brand-800">{line.display_name}</span>
                            {line.display_phone_number && <span className="block truncate text-xs text-brand-400">{line.display_phone_number}</span>}
                          </span>
                        </span>
                      </TD>
                      <TD>
                        <Badge tone={LINE_STATUS_TONE[line.status]}>{t(LINE_STATUS_KEY[line.status])}</Badge>
                      </TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          {assignedAgent && <InitialsAvatar name={assignedAgent.name} size="xs" />}
                          <Select
                            value={line.ai_assistant_id ?? ''}
                            disabled={!assistants || assigningLineId === line.id || line.status === 'disconnected'}
                            onChange={(e) => handleAssign(line.id, e.target.value)}
                            className="!w-auto !py-1 text-xs"
                          >
                            <option value="">{t('settings.lines.table.noAgentOption')}</option>
                            {(assistants ?? []).map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </TD>
                      <TD className="text-xs text-brand-400">{formatActivity(lastActivityByLine.get(line.id), language, t('settings.lines.noActivity'))}</TD>
                      <TD className="text-right">
                        {canManage && line.status !== 'disconnected' && (
                          <Button variant="ghost" onClick={() => setConfirmingDeleteLineId(line.id)} className="!px-2 !py-1.5 text-xs !text-red-600">
                            <TrashIcon width={13} height={13} />
                          </Button>
                        )}
                      </TD>
                    </TRow>
                  )
                })}
              </TBody>
            </Table>
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
            <Table>
              <THead>
                <tr>
                  <TH>{t('settings.lines.agentTable.agent')}</TH>
                  <TH>{t('settings.lines.agentTable.model')}</TH>
                  <TH>{t('settings.lines.agentTable.status')}</TH>
                  <TH>{t('settings.lines.agentTable.assignedLines')}</TH>
                  <TH className="text-right">{t('settings.lines.agentTable.actions')}</TH>
                </tr>
              </THead>
              <TBody>
                {assistants.map((agent) => {
                  const usage = agentUsageCount(agent.id)
                  return (
                    <TRow key={agent.id}>
                      <TD>
                        <span className="flex items-center gap-3">
                          <InitialsAvatar name={agent.name} size="sm" />
                          <span className="font-medium text-brand-800">{agent.name}</span>
                        </span>
                      </TD>
                      <TD className="text-xs text-brand-500">
                        {t(PROVIDER_KEY[agent.provider])} · {agent.model}
                      </TD>
                      <TD>
                        <Badge tone={agent.is_active ? 'success' : 'warning'}>{t(agent.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                      </TD>
                      <TD className="text-xs text-brand-500">
                        {usage === 0
                          ? t('settings.lines.agentTable.noLines')
                          : t(usage === 1 ? 'settings.lines.agentTable.linesOne' : 'settings.lines.agentTable.linesOther', { count: usage })}
                      </TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" onClick={() => setAgentDrawer({ open: true, assistantId: agent.id })} className="!px-2 !py-1.5 text-xs">
                            <PencilIcon width={13} height={13} />
                          </Button>
                          {canManage && (
                            <Button variant="ghost" onClick={() => setConfirmingDeleteAgentId(agent.id)} className="!px-2 !py-1.5 text-xs !text-red-600">
                              <TrashIcon width={13} height={13} />
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TRow>
                  )
                })}
              </TBody>
            </Table>
          )}
        </>
      )}

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
