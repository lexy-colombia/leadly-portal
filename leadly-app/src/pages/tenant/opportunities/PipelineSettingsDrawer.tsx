import { useEffect, useState, type FormEvent } from 'react'
import {
  createStage,
  deletePipeline,
  deleteStage,
  reorderStages,
  updatePipeline,
  updateStage,
  type StageInput,
} from '../../../lib/api/pipelines'
import type { CrmPipeline, CrmPipelineStage } from '../../../types/domain'
import { Button, ConfirmDialog, Drawer, Input, Label, Select } from '../../../components/ui'
import { ChevronLeftIcon, PlusIcon, TrashIcon } from '../../../components/icons'

type StageOutcome = 'abierta' | 'ganada' | 'perdida'

function outcomeOf(stage: Pick<CrmPipelineStage, 'is_won' | 'is_lost'>): StageOutcome {
  if (stage.is_won) return 'ganada'
  if (stage.is_lost) return 'perdida'
  return 'abierta'
}

function outcomeToFlags(outcome: StageOutcome): { is_won: boolean; is_lost: boolean } {
  return { is_won: outcome === 'ganada', is_lost: outcome === 'perdida' }
}

const NEW_STAGE_DEFAULTS: StageInput = { name: 'Nueva etapa', color: '#94A3B8', probability: 0, is_won: false, is_lost: false }

export function PipelineSettingsDrawer({
  open,
  onClose,
  tenantId,
  pipeline,
  pipelineCount,
  stages,
  onPipelineChange,
  onPipelineDeleted,
  onStagesChange,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  pipeline: CrmPipeline
  pipelineCount: number
  stages: CrmPipelineStage[]
  onPipelineChange: () => void
  onPipelineDeleted: () => void
  onStagesChange: () => void
}) {
  const [name, setName] = useState(pipeline.name)
  const [description, setDescription] = useState(pipeline.description ?? '')
  const [color, setColor] = useState(pipeline.color)
  const [savingPipeline, setSavingPipeline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localStages, setLocalStages] = useState<CrmPipelineStage[]>(stages)
  const [addingStage, setAddingStage] = useState(false)
  const [stageToDelete, setStageToDelete] = useState<CrmPipelineStage | null>(null)
  const [deletingStage, setDeletingStage] = useState(false)
  const [deletePipelineOpen, setDeletePipelineOpen] = useState(false)
  const [deletingPipeline, setDeletingPipeline] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(pipeline.name)
    setDescription(pipeline.description ?? '')
    setColor(pipeline.color)
    setError(null)
  }, [open, pipeline])

  useEffect(() => {
    setLocalStages(stages)
  }, [stages])

  async function handleSavePipeline(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSavingPipeline(true)
    setError(null)
    try {
      await updatePipeline(pipeline.id, { name: name.trim(), description: description.trim() || null, color })
      onPipelineChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el pipeline.')
    } finally {
      setSavingPipeline(false)
    }
  }

  async function handleStageFieldSave(stage: CrmPipelineStage, input: Partial<StageInput>) {
    setError(null)
    try {
      await updateStage(stage.id, input)
      onStagesChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la etapa.')
    }
  }

  async function handleAddStage() {
    setAddingStage(true)
    setError(null)
    try {
      await createStage(pipeline.id, NEW_STAGE_DEFAULTS)
      onStagesChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo agregar la etapa.')
    } finally {
      setAddingStage(false)
    }
  }

  async function handleMoveStage(index: number, direction: -1 | 1) {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= localStages.length) return
    const reordered = [...localStages]
    ;[reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]]
    setLocalStages(reordered)
    setError(null)
    try {
      await reorderStages(reordered.map((s) => s.id))
      onStagesChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo reordenar las etapas.')
      setLocalStages(stages)
    }
  }

  async function handleConfirmDeleteStage() {
    if (!stageToDelete) return
    setDeletingStage(true)
    try {
      await deleteStage(pipeline.id, stageToDelete.id)
      setStageToDelete(null)
      onStagesChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar la etapa.')
      setStageToDelete(null)
    } finally {
      setDeletingStage(false)
    }
  }

  async function handleConfirmDeletePipeline() {
    setDeletingPipeline(true)
    try {
      await deletePipeline(tenantId, pipeline.id)
      setDeletePipelineOpen(false)
      onPipelineChange()
      onPipelineDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar el pipeline.')
      setDeletePipelineOpen(false)
    } finally {
      setDeletingPipeline(false)
    }
  }

  return (
    <>
      <Drawer open={open} onClose={onClose} title="Configurar pipeline" description="Nombre, etapas y su orden en el tablero.">
        <div className="space-y-6">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <form onSubmit={handleSavePipeline} className="space-y-3">
            <div>
              <Label htmlFor="pipeline-name">Nombre</Label>
              <Input id="pipeline-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="pipeline-description">Descripción (opcional)</Label>
              <Input id="pipeline-description" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="pipeline-color">Color</Label>
              <input
                id="pipeline-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-brand-200"
              />
            </div>
            <Button type="submit" variant="secondary" disabled={savingPipeline || !name.trim()} className="!py-1.5 text-xs">
              {savingPipeline ? 'Guardando…' : 'Guardar pipeline'}
            </Button>
          </form>

          <div className="border-t border-brand-100 pt-4">
            <p className="mb-2 text-sm font-semibold text-brand-800">Etapas</p>
            <div className="space-y-2">
              {localStages.map((stage, index) => (
                <div key={stage.id} className="flex items-center gap-1.5 rounded-xl border border-brand-100 p-2">
                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      onClick={() => handleMoveStage(index, -1)}
                      disabled={index === 0}
                      aria-label="Subir etapa"
                      className="text-brand-400 hover:text-brand-700 disabled:opacity-30"
                    >
                      <ChevronLeftIcon width={12} height={12} className="rotate-90" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveStage(index, 1)}
                      disabled={index === localStages.length - 1}
                      aria-label="Bajar etapa"
                      className="text-brand-400 hover:text-brand-700 disabled:opacity-30"
                    >
                      <ChevronLeftIcon width={12} height={12} className="-rotate-90" />
                    </button>
                  </div>

                  <input
                    type="color"
                    defaultValue={stage.color}
                    onBlur={(e) => e.target.value !== stage.color && handleStageFieldSave(stage, { color: e.target.value })}
                    className="h-8 w-8 shrink-0 cursor-pointer rounded border border-brand-200"
                  />

                  <Input
                    defaultValue={stage.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== stage.name && handleStageFieldSave(stage, { name: e.target.value.trim() })}
                    className="!py-1.5 text-sm"
                  />

                  <Input
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={stage.probability}
                    onBlur={(e) => {
                      const value = Number(e.target.value)
                      if (!Number.isNaN(value) && value !== stage.probability) handleStageFieldSave(stage, { probability: Math.min(100, Math.max(0, value)) })
                    }}
                    className="!w-16 !py-1.5 text-sm"
                  />

                  <Select
                    defaultValue={outcomeOf(stage)}
                    onChange={(e) => handleStageFieldSave(stage, outcomeToFlags(e.target.value as StageOutcome))}
                    className="!w-auto !py-1.5 text-xs"
                  >
                    <option value="abierta">Abierta</option>
                    <option value="ganada">Ganada</option>
                    <option value="perdida">Perdida</option>
                  </Select>

                  <button
                    type="button"
                    onClick={() => setStageToDelete(stage)}
                    aria-label={`Eliminar etapa ${stage.name}`}
                    className="shrink-0 rounded-lg p-1.5 text-brand-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <TrashIcon width={14} height={14} />
                  </button>
                </div>
              ))}
            </div>

            <Button type="button" variant="ghost" onClick={handleAddStage} disabled={addingStage} className="!mt-3 !py-1.5 text-xs">
              <PlusIcon width={13} height={13} /> {addingStage ? 'Agregando…' : 'Agregar etapa'}
            </Button>
          </div>

          <div className="border-t border-brand-100 pt-4">
            {pipelineCount <= 1 ? (
              <p className="text-xs text-brand-400">No podés eliminar el único pipeline del equipo.</p>
            ) : (
              <Button type="button" variant="danger" onClick={() => setDeletePipelineOpen(true)} className="!py-1.5 text-xs">
                <TrashIcon width={13} height={13} /> Eliminar pipeline
              </Button>
            )}
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!stageToDelete}
        onClose={() => setStageToDelete(null)}
        onConfirm={handleConfirmDeleteStage}
        title="Eliminar etapa"
        description={`¿Eliminar la etapa "${stageToDelete?.name}"? Si ya tiene oportunidades o historial, no se podrá eliminar.`}
        loading={deletingStage}
      />

      <ConfirmDialog
        open={deletePipelineOpen}
        onClose={() => setDeletePipelineOpen(false)}
        onConfirm={handleConfirmDeletePipeline}
        title="Eliminar pipeline"
        description={`¿Eliminar el pipeline "${pipeline.name}"? Si ya tiene oportunidades, no se podrá eliminar.`}
        loading={deletingPipeline}
      />
    </>
  )
}
