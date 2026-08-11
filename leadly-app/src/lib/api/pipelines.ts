import { supabase } from '../supabaseClient'
import type { CrmPipeline, CrmPipelineStage } from '../../types/domain'

/** Same 6 stages the `seed_default_pipeline` DB trigger seeds for a brand
 * new tenant -- reused here so a manually created pipeline is immediately
 * usable instead of landing empty (an opportunity can't exist without a
 * stage_id, so a 0-stage pipeline would be a dead end until someone added
 * stages by hand first). */
const DEFAULT_STAGES = [
  { name: 'Nuevo', display_order: 0, probability: 10, is_won: false, is_lost: false },
  { name: 'Contactado', display_order: 1, probability: 25, is_won: false, is_lost: false },
  { name: 'Propuesta', display_order: 2, probability: 50, is_won: false, is_lost: false },
  { name: 'Negociación', display_order: 3, probability: 75, is_won: false, is_lost: false },
  { name: 'Ganado', display_order: 4, probability: 100, is_won: true, is_lost: false },
  { name: 'Perdido', display_order: 5, probability: 0, is_won: false, is_lost: true },
]

/** Postgres FK error code for a restricted delete (crm_opportunities.pipeline_id/
 * stage_id and crm_opportunity_stage_history.to_stage_id are all `on delete
 * restrict`) -- translated here into a message an agent can actually act on,
 * instead of the raw constraint-violation text bubbling up to the UI. */
function friendlyDeleteError(err: unknown, whatInUse: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('foreign key constraint') || message.includes('violates')) {
    return new Error(`No se puede eliminar: ${whatInUse} ya tiene oportunidades o historial asociado.`)
  }
  return err instanceof Error ? err : new Error(message)
}

export async function listPipelinesByTenant(tenantId: string): Promise<CrmPipeline[]> {
  const { data, error } = await supabase.from('crm_pipelines').select('*').eq('tenant_id', tenantId).eq('is_active', true).order('created_at')
  if (error) throw error
  return data
}

export async function createPipeline(tenantId: string, name: string): Promise<CrmPipeline> {
  const { data: pipeline, error } = await supabase.from('crm_pipelines').insert({ tenant_id: tenantId, name }).select().single()
  if (error) throw error

  const { error: stagesError } = await supabase
    .from('crm_pipeline_stages')
    .insert(DEFAULT_STAGES.map((stage) => ({ ...stage, pipeline_id: pipeline.id })))
  if (stagesError) {
    await supabase.from('crm_pipelines').delete().eq('id', pipeline.id)
    throw stagesError
  }

  return pipeline
}

export interface PipelineUpdateInput {
  name?: string
  description?: string | null
  color?: string
}

export async function updatePipeline(id: string, input: PipelineUpdateInput): Promise<CrmPipeline> {
  const { data, error } = await supabase.from('crm_pipelines').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Refuses client-side if this is the tenant's only pipeline -- Oportunidades.tsx
 * would have nowhere to point after deleting it. Postgres itself refuses (FK
 * restrict) if the pipeline still has opportunities. */
export async function deletePipeline(tenantId: string, id: string): Promise<void> {
  const remaining = await listPipelinesByTenant(tenantId)
  if (remaining.length <= 1) {
    throw new Error('No podés eliminar el único pipeline del equipo.')
  }
  const { error } = await supabase.from('crm_pipelines').delete().eq('id', id)
  if (error) throw friendlyDeleteError(error, 'este pipeline')
}

export interface StageInput {
  name: string
  color: string
  probability: number
  is_won: boolean
  is_lost: boolean
}

export async function createStage(pipelineId: string, input: StageInput): Promise<CrmPipelineStage> {
  const { data: existing, error: existingError } = await supabase
    .from('crm_pipeline_stages')
    .select('display_order')
    .eq('pipeline_id', pipelineId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  const { data, error } = await supabase
    .from('crm_pipeline_stages')
    .insert({ ...input, pipeline_id: pipelineId, display_order: (existing?.display_order ?? -1) + 1 })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateStage(id: string, input: Partial<StageInput>): Promise<CrmPipelineStage> {
  const { data, error } = await supabase.from('crm_pipeline_stages').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Bulk-reassigns display_order to match array index -- a plain loop of
 * per-row updates is fine at this scale (a pipeline realistically has well
 * under 10 stages), no need for a bulk-upsert RPC. */
export async function reorderStages(orderedStageIds: string[]): Promise<void> {
  await Promise.all(orderedStageIds.map((id, index) => supabase.from('crm_pipeline_stages').update({ display_order: index }).eq('id', id)))
}

export async function deleteStage(pipelineId: string, id: string): Promise<void> {
  const { data: existing, error: existingError } = await supabase.from('crm_pipeline_stages').select('id').eq('pipeline_id', pipelineId)
  if (existingError) throw existingError
  if ((existing?.length ?? 0) <= 1) {
    throw new Error('No podés eliminar la última etapa de un pipeline.')
  }
  const { error } = await supabase.from('crm_pipeline_stages').delete().eq('id', id)
  if (error) throw friendlyDeleteError(error, 'esta etapa')
}
