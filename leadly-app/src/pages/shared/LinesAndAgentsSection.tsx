import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { deleteWhatsappLine, listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import { assignAiAssistantToLine, deleteAiAssistant, listAiAssistantsByTenant } from '../../lib/api/aiAssistants'
import { listConversations, type ConversationWithLine } from '../../lib/api/conversations'
import type { AiAssistant, AiProvider, WhatsappLine, WhatsappLineStatus } from '../../types/domain'
import { Badge, Button, ConfirmDialog, EmptyState, InitialsAvatar, PageSpinner, Select, TBody, TD, TH, THead, Table, TRow } from '../../components/ui'
import { AiSparkleIcon, ChatBubbleIcon, PencilIcon, PhoneIcon, PlusIcon, TrashIcon } from '../../components/icons'
import { AiAssistantDrawer } from './AiAssistantDrawer'

const LINE_STATUS_LABEL: Record<WhatsappLineStatus, string> = {
  pending_verification: 'Pendiente de verificación',
  active: 'Activa',
  suspended: 'Suspendida',
  disconnected: 'Desconectada',
}

const LINE_STATUS_TONE: Record<WhatsappLineStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending_verification: 'warning',
  active: 'success',
  suspended: 'danger',
  disconnected: 'neutral',
}

const PROVIDER_LABEL: Record<AiProvider, string> = { openai: 'OpenAI (ChatGPT)', gemini: 'Google (Gemini)' }

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString()
}

function formatActivity(iso: string | undefined): string {
  if (!iso) return 'Sin actividad'
  const date = new Date(iso)
  return isToday(iso) ? date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })
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

  function reload() {
    listWhatsappLinesByTenant(tenantId).then(setLines).catch((err) => setError(err.message ?? 'No se pudieron cargar las líneas.'))
    listAiAssistantsByTenant(tenantId)
      .then(setAssistants)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar los agentes.'))
    listConversations(tenantId)
      .then(setConversations)
      .catch(() => setConversations([]))
  }

  useEffect(reload, [tenantId])

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

  async function handleDeleteLine(lineId: string) {
    setDeletingLineId(lineId)
    setDeleteLineError(null)
    try {
      await deleteWhatsappLine(lineId)
      setConfirmingDeleteLineId(null)
      reload()
    } catch (err) {
      setDeleteLineError(err instanceof Error ? err.message : 'No se pudo desconectar la línea.')
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
      setDeleteAgentError(err instanceof Error ? err.message : 'No se pudo eliminar el agente.')
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
      setError(err instanceof Error ? err.message : 'No se pudo asignar el agente.')
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
              ['lineas', 'Líneas de WhatsApp', PhoneIcon],
              ['agentes', 'Agentes de IA', AiSparkleIcon],
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
              <Button variant="primary" onClick={connectLine.onClick} disabled={connectLine.loading} className="!py-1.5 text-xs">
                <PlusIcon width={14} height={14} /> {connectLine.loading ? 'Conectando…' : connectLine.label}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setLineDrawerState({ open: true, line: null })} className="!py-1.5 text-xs">
                <PlusIcon width={14} height={14} /> Nueva línea
              </Button>
            )
          ) : (
            <Button variant="primary" onClick={() => setAgentDrawer({ open: true, assistantId: null })} className="!py-1.5 text-xs">
              <PlusIcon width={14} height={14} /> Nuevo agente
            </Button>
          ))}
      </div>

      {showMetrics && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <MetricCard
            icon={<PhoneIcon width={16} height={16} />}
            iconClass="bg-emerald-50 text-emerald-600"
            value={String(connectedLines)}
            label="Líneas conectadas"
            sublabel={lines ? `${lines.length} en total` : undefined}
          />
          <MetricCard
            icon={<AiSparkleIcon width={16} height={16} />}
            iconClass="bg-violet-50 text-violet-600"
            value={String(linesWithAgent)}
            label="Con agente asignado"
            sublabel={lines && lines.length > 0 ? `${Math.round((linesWithAgent / lines.length) * 100)}% de las líneas` : undefined}
          />
          <MetricCard
            icon={<ChatBubbleIcon width={16} height={16} />}
            iconClass="bg-sky-50 text-sky-600"
            value={String(conversationsToday)}
            label="Conversaciones hoy"
          />
          <MetricCard
            icon={<AiSparkleIcon width={16} height={16} />}
            iconClass="bg-amber-50 text-amber-600"
            value={String(activeAgents)}
            label="Agentes activos"
            sublabel={assistants ? `${assistants.length} en total` : undefined}
          />
        </div>
      )}

      {tab === 'lineas' && (
        <>
          {!lines && !error && <PageSpinner />}
          {lines && lines.length === 0 && (
            <EmptyState>
              {connectLine
                ? 'Todavía no tienes ninguna línea de WhatsApp conectada. Usa "Conectar nueva línea" para vincular tu propia cuenta de WhatsApp Business (los costos de Meta quedan a tu nombre), o contacta a Leadly para que te asignen una manualmente.'
                : 'Este cliente todavía no tiene líneas de WhatsApp asignadas.'}
            </EmptyState>
          )}
          {lines && lines.length > 0 && (
            <Table>
              <THead>
                <tr>
                  <TH>Línea de WhatsApp</TH>
                  <TH>Estado</TH>
                  <TH>Agente asignado</TH>
                  <TH>Última actividad</TH>
                  <TH className="text-right">Acciones</TH>
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
                        <Badge tone={LINE_STATUS_TONE[line.status]}>{LINE_STATUS_LABEL[line.status]}</Badge>
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
                            <option value="">Sin agente asignado</option>
                            {(assistants ?? []).map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </TD>
                      <TD className="text-xs text-brand-400">{formatActivity(lastActivityByLine.get(line.id))}</TD>
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
              <span>Cada línea de WhatsApp solo puede tener un agente de IA asignado.</span>
              <span>
                Mostrando {lines.length} de {lines.length} líneas
              </span>
            </p>
          )}
        </>
      )}

      {tab === 'agentes' && (
        <>
          {!assistants && !error && <PageSpinner />}
          {assistants && assistants.length === 0 && <EmptyState>Todavía no tienes ningún agente configurado.</EmptyState>}
          {assistants && assistants.length > 0 && (
            <Table>
              <THead>
                <tr>
                  <TH>Agente</TH>
                  <TH>Modelo</TH>
                  <TH>Estado</TH>
                  <TH>Líneas asignadas</TH>
                  <TH className="text-right">Acciones</TH>
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
                        {PROVIDER_LABEL[agent.provider]} · {agent.model}
                      </TD>
                      <TD>
                        <Badge tone={agent.is_active ? 'success' : 'warning'}>{agent.is_active ? 'Activo' : 'Inactivo'}</Badge>
                      </TD>
                      <TD className="text-xs text-brand-500">{usage === 0 ? 'Ninguna' : `${usage} línea${usage === 1 ? '' : 's'}`}</TD>
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
        title="Desconectar línea de WhatsApp"
        description={`Vas a desconectar "${lines?.find((l) => l.id === confirmingDeleteLineId)?.display_name ?? ''}". No va a poder enviar ni recibir mensajes nunca más. Si ya tiene conversaciones, se conservan con su historial completo y la línea queda marcada como desconectada en vez de eliminarse; si no tiene ninguna, se elimina del todo.`}
        confirmLabel="Desconectar"
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
        title="Eliminar agente"
        description={`Vas a eliminar "${assistants?.find((a) => a.id === confirmingDeleteAgentId)?.name ?? ''}". Si está asignado a alguna línea, primero tenés que reasignarla.`}
        confirmLabel="Eliminar"
      />
    </div>
  )
}
