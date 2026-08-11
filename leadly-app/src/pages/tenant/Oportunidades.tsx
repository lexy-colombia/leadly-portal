import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
  computePipelineMetrics,
  listOpportunities,
  listStageHistoryForOpportunities,
  listStages,
  moveOpportunityToStage,
} from '../../lib/api/opportunities'
import type { OpportunityWithRelations, StageHistoryRow } from '../../lib/api/opportunities'
import { createPipeline, listPipelinesByTenant } from '../../lib/api/pipelines'
import { listTasks } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import { listProfilesByTenant } from '../../lib/api/users'
import type { CrmPipeline, CrmPipelineStage, OpportunityPriority, Profile } from '../../types/domain'
import { Badge, Button, Input, InitialsAvatar, PageSpinner, Select } from '../../components/ui'
import { CalendarIcon, CheckIcon, ChevronLeftIcon, FilterIcon, MailIcon, PhoneIcon, PlusIcon, SettingsIcon } from '../../components/icons'
import { OpportunityDrawer } from './opportunities/OpportunityDrawer'
import { OpportunityListView } from './opportunities/OpportunityListView'
import { OpportunityPanel } from './opportunities/OpportunityPanel'
import { PipelineSettingsDrawer } from './opportunities/PipelineSettingsDrawer'

const PRIORITY_LABEL: Record<OpportunityPriority, string> = { baja: 'Baja', media: 'Media', alta: 'Alta' }
type SortBy = 'recent' | 'value_desc' | 'value_asc' | 'close_date'

const PRIORITY_TONE: Record<OpportunityPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })
}

function formatCompactCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return formatCurrency(value)
}

function MetricTile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'success' | 'danger' }) {
  const valueClass = tone === 'success' ? 'text-green-600' : tone === 'danger' ? 'text-red-600' : 'text-brand-800'
  return (
    <div className="min-w-0 rounded-lg border border-brand-100 bg-white px-2 py-1">
      <p className={`truncate text-xs font-bold sm:text-sm ${valueClass}`}>{value}</p>
      <p className="truncate text-[10px] text-brand-400">{label}</p>
    </div>
  )
}

export function Oportunidades() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'tenant_admin'
  const [pipelines, setPipelines] = useState<CrmPipeline[] | undefined>(undefined)
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null)
  const [stages, setStages] = useState<CrmPipelineStage[]>([])
  const [opportunities, setOpportunities] = useState<OpportunityWithRelations[] | null>(null)
  const [history, setHistory] = useState<StageHistoryRow[]>([])
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [agents, setAgents] = useState<Profile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ open: boolean; opportunity: OpportunityWithRelations | null }>({ open: false, opportunity: null })
  const [panelOpportunity, setPanelOpportunity] = useState<OpportunityWithRelations | null>(null)
  const [panelInitialTab, setPanelInitialTab] = useState<'resumen' | 'conversaciones' | 'tareas'>('resumen')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pipelinePopoverOpen, setPipelinePopoverOpen] = useState(false)
  const [newPipelineName, setNewPipelineName] = useState('')
  const [creatingPipeline, setCreatingPipeline] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'kanban' | 'lista'>('kanban')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<OpportunityPriority | ''>('')
  const [stageFilter, setStageFilter] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('recent')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const pipelinePopoverRef = useRef<HTMLDivElement>(null)
  const filtersRef = useRef<HTMLDivElement>(null)

  const pipeline = pipelines?.find((p) => p.id === selectedPipelineId) ?? null

  function reloadPipelines() {
    if (!profile?.tenant_id) return
    listPipelinesByTenant(profile.tenant_id)
      .then((list) => {
        setPipelines(list)
        setSelectedPipelineId((prev) => (prev && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null)))
      })
      .catch((err) => setError(err.message ?? 'No se pudo cargar el pipeline.'))
  }

  function reload() {
    if (!profile?.tenant_id) return
    listOpportunities(profile.tenant_id, selectedPipelineId ?? undefined)
      .then(setOpportunities)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar las oportunidades.'))
    listTasks(profile.tenant_id)
      .then(setTasks)
      .catch(() => {})
  }

  useEffect(reloadPipelines, [profile?.tenant_id])

  useEffect(() => {
    if (!profile?.tenant_id) return
    listProfilesByTenant(profile.tenant_id).then(setAgents).catch(() => {})
  }, [profile?.tenant_id])

  useEffect(() => {
    if (!selectedPipelineId) {
      setStages([])
      return
    }
    listStages(selectedPipelineId).then(setStages).catch(() => {})
    setOpportunities(null)
    setStageFilter('')
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPipelineId])

  useEffect(() => {
    if (!pipelinePopoverOpen) return
    function handleClick(e: MouseEvent) {
      if (pipelinePopoverRef.current && !pipelinePopoverRef.current.contains(e.target as Node)) setPipelinePopoverOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pipelinePopoverOpen])

  useEffect(() => {
    if (!filtersOpen) return
    function handleClick(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [filtersOpen])

  useEffect(() => {
    if (!opportunities) return
    listStageHistoryForOpportunities(opportunities.map((o) => o.id)).then(setHistory).catch(() => {})
  }, [opportunities])

  async function handleCreatePipeline(e: FormEvent) {
    e.preventDefault()
    const name = newPipelineName.trim()
    if (!name || !profile?.tenant_id) return
    setCreatingPipeline(true)
    setError(null)
    try {
      const created = await createPipeline(profile.tenant_id, name)
      setPipelines((prev) => (prev ? [...prev, created] : [created]))
      setSelectedPipelineId(created.id)
      setNewPipelineName('')
      setPipelinePopoverOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el pipeline.')
    } finally {
      setCreatingPipeline(false)
    }
  }

  // Responsable/Prioridad filters + orden se aplican sobre una sola lista
  // derivada, que alimenta tanto el Kanban (agrupado por etapa) como la Lista
  // (plana) -- así ambas vistas siempre muestran exactamente lo mismo.
  const visibleOpportunities = useMemo(() => {
    let list = opportunities ?? []
    if (ownerFilter) list = list.filter((o) => o.owner_id === ownerFilter)
    if (priorityFilter) list = list.filter((o) => o.priority === priorityFilter)
    if (stageFilter) list = list.filter((o) => o.stage_id === stageFilter)
    const sorted = [...list]
    if (sortBy === 'value_desc') sorted.sort((a, b) => b.value - a.value)
    else if (sortBy === 'value_asc') sorted.sort((a, b) => a.value - b.value)
    else if (sortBy === 'close_date') {
      sorted.sort((a, b) => {
        if (!a.expected_close_date && !b.expected_close_date) return 0
        if (!a.expected_close_date) return 1
        if (!b.expected_close_date) return -1
        return a.expected_close_date.localeCompare(b.expected_close_date)
      })
    }
    // 'recent' conserva el orden que ya trae listOpportunities (updated_at desc)
    return sorted
  }, [opportunities, ownerFilter, priorityFilter, stageFilter, sortBy])

  const hasActiveFilters = !!ownerFilter || !!priorityFilter || !!stageFilter

  const metrics = useMemo(() => computePipelineMetrics(visibleOpportunities, history), [visibleOpportunities, history])

  const byStage = useMemo(() => {
    const map = new Map<string, OpportunityWithRelations[]>()
    for (const stage of stages) map.set(stage.id, [])
    for (const opp of visibleOpportunities) {
      if (!map.has(opp.stage_id)) map.set(opp.stage_id, [])
      map.get(opp.stage_id)!.push(opp)
    }
    return map
  }, [stages, visibleOpportunities])

  const pendingTaskCount = useMemo(() => (tasks ?? []).filter((t) => t.status === 'pendiente' || t.status === 'en_proceso').length, [tasks])

  // Pending-task count per opportunity -- shown as a small badge on each
  // Kanban card so a linked task is visible without opening the panel
  // (the full list still lives in OpportunityPanel's "Tareas" tab).
  const pendingTaskCountByOpportunity = useMemo(() => {
    const map = new Map<string, number>()
    for (const task of tasks ?? []) {
      if (!task.opportunity_id) continue
      if (task.status !== 'pendiente' && task.status !== 'en_proceso') continue
      map.set(task.opportunity_id, (map.get(task.opportunity_id) ?? 0) + 1)
    }
    return map
  }, [tasks])

  async function moveOpportunity(oppId: string, stage: CrmPipelineStage) {
    const opp = opportunities?.find((o) => o.id === oppId)
    if (!opp || opp.stage_id === stage.id) return

    setMovingId(oppId)
    // Optimistic move -- dragging a card (o cambiar el select en la Lista) y
    // que la fila/card vuelva atrás después de un round-trip se lee como
    // roto, aunque el request en sí sea rápido.
    setOpportunities((prev) => (prev ? prev.map((o) => (o.id === oppId ? { ...o, stage_id: stage.id } : o)) : prev))
    try {
      await moveOpportunityToStage(oppId, stage)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo mover la oportunidad.')
      reload()
    } finally {
      setMovingId(null)
    }
  }

  async function handleDrop(stage: CrmPipelineStage, oppId: string) {
    setDragOverStage(null)
    setDraggingId(null)
    if (!oppId) return
    await moveOpportunity(oppId, stage)
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] min-w-0 flex-col space-y-2.5 lg:h-[calc(100vh-6.5rem)]">
      <div className="flex flex-wrap items-center gap-2">
        <div ref={pipelinePopoverRef} className="relative">
          <button
            type="button"
            onClick={() => setPipelinePopoverOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-full border border-brand-200 px-2.5 py-1 text-xs font-medium text-brand-700 hover:border-brand-300"
          >
            Pipeline: {pipeline?.name ?? '—'}
            <ChevronLeftIcon width={12} height={12} className="-rotate-90 text-brand-300" />
          </button>

          {pipelinePopoverOpen && (
            <div className="absolute left-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-2xl border border-brand-100 bg-white p-2 shadow-lg">
              {(pipelines ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setSelectedPipelineId(p.id)
                    setPipelinePopoverOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm ${
                    p.id === selectedPipelineId ? 'bg-accent-50 text-accent-700' : 'text-brand-700 hover:bg-brand-50'
                  }`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
              {isAdmin && (
                <form onSubmit={handleCreatePipeline} className="flex gap-1.5 border-t border-brand-100 p-1 pt-2">
                  <Input
                    value={newPipelineName}
                    onChange={(e) => setNewPipelineName(e.target.value)}
                    placeholder="Nuevo pipeline..."
                    className="!py-1.5 text-xs"
                  />
                  <Button type="submit" variant="secondary" disabled={creatingPipeline || !newPipelineName.trim()} className="!px-2.5 !py-1.5 text-xs shrink-0">
                    <PlusIcon width={13} height={13} />
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>

        {isAdmin && pipeline && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Configurar pipeline"
            className="rounded-full border border-brand-200 p-1 text-brand-500 hover:border-brand-300 hover:bg-brand-50"
          >
            <SettingsIcon width={14} height={14} />
          </button>
        )}

        <div className="flex gap-1 rounded-full bg-brand-50 p-0.5">
          {(['kanban', 'lista'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                viewMode === mode ? 'bg-white text-brand-800 shadow-sm' : 'text-brand-400 hover:text-brand-700'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        <Select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="!w-auto !py-1 text-xs">
          <option value="">Todos los responsables</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name}
            </option>
          ))}
        </Select>

        <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} className="!w-auto !py-1 text-xs">
          <option value="recent">Ordenar por: Más reciente</option>
          <option value="value_desc">Ordenar por: Valor (mayor a menor)</option>
          <option value="value_asc">Ordenar por: Valor (menor a mayor)</option>
          <option value="close_date">Ordenar por: Cierre más próximo</option>
        </Select>

        <div ref={filtersRef} className="relative">
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium transition-colors ${
              hasActiveFilters ? 'border-accent-300 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-600 hover:bg-brand-50'
            }`}
          >
            <FilterIcon width={13} height={13} />
            Filtros
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </button>

          {filtersOpen && (
            <div className="absolute left-0 top-full z-40 mt-2 w-56 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-brand-100 bg-white p-4 shadow-lg">
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">Etapa</label>
                <Select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="!py-1.5 text-sm">
                  <option value="">Todas</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">Prioridad</label>
                <Select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as OpportunityPriority | '')} className="!py-1.5 text-sm">
                  <option value="">Todas</option>
                  {(Object.keys(PRIORITY_LABEL) as OpportunityPriority[]).map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setOwnerFilter('')
                    setPriorityFilter('')
                    setStageFilter('')
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-700"
                >
                  Limpiar filtros
                </button>
              )}
            </div>
          )}
        </div>

        <Button variant="primary" onClick={() => setDrawer({ open: true, opportunity: null })} disabled={!pipeline} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> Nueva oportunidad
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 lg:grid-cols-7">
        <MetricTile label="Valor total" value={formatCompactCurrency(metrics.totalValue)} />
        <MetricTile label="Ganado" value={formatCompactCurrency(metrics.wonValue)} tone="success" />
        <MetricTile label="Perdido" value={formatCompactCurrency(metrics.lostValue)} tone="danger" />
        <MetricTile label="Oportunidades" value={String(metrics.count)} />
        <MetricTile label="Conversión" value={metrics.conversionPct === null ? '—' : `${Math.round(metrics.conversionPct)}%`} />
        <MetricTile label="Tiempo promedio" value={metrics.avgCloseDays === null ? '—' : `${Math.round(metrics.avgCloseDays)} días`} />
        <MetricTile label="Tareas pendientes" value={tasks === null ? '—' : String(pendingTaskCount)} />
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {(!opportunities || pipelines === undefined) && !error && <PageSpinner />}

      {opportunities && pipeline && stages.length > 0 && viewMode === 'lista' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OpportunityListView
            opportunities={visibleOpportunities}
            stages={stages}
            onOpen={(opp) => {
              setPanelInitialTab('resumen')
              setPanelOpportunity(opp)
            }}
            onStageChange={(opp, stage) => moveOpportunity(opp.id, stage)}
          />
        </div>
      )}

      {opportunities && pipeline && stages.length > 0 && viewMode === 'kanban' && (
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto pb-2">
          {stages
            .filter((stage) => !stageFilter || stage.id === stageFilter)
            .map((stage) => {
            const stageOpps = byStage.get(stage.id) ?? []
            const stageValue = stageOpps.reduce((sum, o) => sum + o.value, 0)
            const isDragOver = dragOverStage === stage.id
            return (
              <div
                key={stage.id}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (dragOverStage !== stage.id) setDragOverStage(stage.id)
                }}
                onDragLeave={() => setDragOverStage((prev) => (prev === stage.id ? null : prev))}
                onDrop={(e) => {
                  e.preventDefault()
                  const oppId = e.dataTransfer.getData('text/plain')
                  handleDrop(stage, oppId)
                }}
                className={`flex w-60 shrink-0 flex-col rounded-xl border bg-brand-50/60 transition-colors ${
                  isDragOver ? 'border-accent-400 bg-accent-50' : 'border-brand-100'
                }`}
              >
                <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-2.5">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-brand-800">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stage.color }} />
                    {stage.name}
                    <span className="font-normal text-brand-400">({stageOpps.length})</span>
                  </span>
                  <span className="text-[11px] text-brand-400">{formatCompactCurrency(stageValue)}</span>
                </div>

                <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-2.5">
                  {stageOpps.map((opp) => (
                    <div
                      key={opp.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', opp.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDraggingId(opp.id)
                      }}
                      onDragEnd={() => setDraggingId(null)}
                      onClick={() => {
                        setPanelInitialTab('resumen')
                        setPanelOpportunity(opp)
                      }}
                      className={`cursor-pointer rounded-lg border border-brand-100 bg-white p-2.5 shadow-sm transition-opacity hover:border-accent-300 ${
                        draggingId === opp.id || movingId === opp.id ? 'opacity-50' : ''
                      }`}
                    >
                      <p className="text-xs font-medium text-brand-800">{opp.title}</p>
                      {opp.contact && <p className="truncate text-[11px] text-brand-400">{opp.contact.full_name}</p>}

                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="flex items-center gap-1.5">
                          <Badge tone={PRIORITY_TONE[opp.priority]}>{PRIORITY_LABEL[opp.priority]}</Badge>
                          {!!pendingTaskCountByOpportunity.get(opp.id) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPanelInitialTab('tareas')
                                setPanelOpportunity(opp)
                              }}
                              className="flex items-center gap-0.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-500 hover:bg-brand-100 hover:text-brand-700"
                              title="Ver tareas pendientes"
                            >
                              <CheckIcon width={9} height={9} />
                              {pendingTaskCountByOpportunity.get(opp.id)}
                            </button>
                          )}
                        </span>
                        <InitialsAvatar name={opp.contact?.full_name ?? '?'} size="xs" />
                      </div>

                      <p className="mt-1.5 text-xs font-semibold text-brand-700">{formatCurrency(opp.value, opp.currency)}</p>

                      <div className="mt-1.5 flex items-center justify-between border-t border-brand-50 pt-1.5">
                        <div className="flex items-center gap-0.5 text-brand-300">
                          {opp.contact?.phone && (
                            <a
                              href={`tel:${opp.contact.phone}`}
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Llamar"
                              className="rounded-full p-0.5 hover:bg-brand-50 hover:text-accent-600"
                            >
                              <PhoneIcon width={12} height={12} />
                            </a>
                          )}
                          {opp.contact?.email && (
                            <a
                              href={`mailto:${opp.contact.email}`}
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Enviar correo"
                              className="rounded-full p-0.5 hover:bg-brand-50 hover:text-accent-600"
                            >
                              <MailIcon width={12} height={12} />
                            </a>
                          )}
                          <span className="p-0.5">
                            <CalendarIcon width={12} height={12} />
                          </span>
                        </div>
                        <span className="text-[10px] text-brand-300">{formatShortDate(opp.expected_close_date ?? opp.created_at)}</span>
                      </div>
                    </div>
                  ))}
                  {stageOpps.length === 0 && <p className="px-1 py-2 text-center text-[11px] text-brand-300">Sin oportunidades</p>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {profile?.tenant_id && (
        <OpportunityDrawer
          open={drawer.open}
          onClose={() => setDrawer({ open: false, opportunity: null })}
          tenantId={profile.tenant_id}
          pipelineId={pipeline?.id ?? null}
          opportunity={drawer.opportunity}
          onSaved={reload}
        />
      )}

      {profile?.tenant_id && (
        <OpportunityPanel
          open={!!panelOpportunity}
          onClose={() => setPanelOpportunity(null)}
          tenantId={profile.tenant_id}
          pipelineName={pipeline?.name ?? '—'}
          opportunity={panelOpportunity}
          initialTab={panelInitialTab}
          onEdit={(opp) => {
            setPanelOpportunity(null)
            setDrawer({ open: true, opportunity: opp })
          }}
          onChanged={reload}
        />
      )}

      {profile?.tenant_id && pipeline && (
        <PipelineSettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          tenantId={profile.tenant_id}
          pipeline={pipeline}
          pipelineCount={pipelines?.length ?? 0}
          stages={stages}
          onPipelineChange={reloadPipelines}
          onPipelineDeleted={() => setSettingsOpen(false)}
          onStagesChange={() => listStages(pipeline.id).then(setStages).catch(() => {})}
        />
      )}
    </div>
  )
}
