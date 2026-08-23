import { supabase } from '../supabaseClient'
import type { DispatchStatus, DispatchStockEffect } from '../../types/domain'

export async function listDispatchStatuses(tenantId: string): Promise<DispatchStatus[]> {
  const { data, error } = await supabase.from('dispatch_statuses').select('*').eq('tenant_id', tenantId).order('display_order')
  if (error) throw error
  return data
}

export interface DispatchStatusInput {
  name: string
  color: string
  stock_effect: DispatchStockEffect
  is_terminal: boolean
}

export async function createDispatchStatus(tenantId: string, input: DispatchStatusInput): Promise<DispatchStatus> {
  const { data: existing, error: existingError } = await supabase
    .from('dispatch_statuses')
    .select('display_order')
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  const { data, error } = await supabase
    .from('dispatch_statuses')
    .insert({ ...input, tenant_id: tenantId, display_order: (existing?.display_order ?? -1) + 1 })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateDispatchStatus(id: string, input: Partial<DispatchStatusInput>): Promise<DispatchStatus> {
  const { data, error } = await supabase.from('dispatch_statuses').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Same shape as reorderStages (lib/api/pipelines.ts) -- a plain loop of
 * per-row updates, fine at this scale (a tenant realistically has well
 * under 10 dispatch statuses). */
export async function reorderDispatchStatuses(orderedIds: string[]): Promise<void> {
  await Promise.all(orderedIds.map((id, index) => supabase.from('dispatch_statuses').update({ display_order: index }).eq('id', id)))
}

/** Refuses client-side if this is the tenant's last status -- a dispatch
 * always needs somewhere to start. Postgres itself refuses (FK restrict
 * on dispatches.status_id/dispatch_status_history.to_status_id) if the
 * status is still referenced by an existing dispatch. */
export async function deleteDispatchStatus(tenantId: string, id: string): Promise<void> {
  const remaining = await listDispatchStatuses(tenantId)
  if (remaining.length <= 1) {
    throw new Error('settings.dispatches.errors.onlyStatus')
  }
  const { error } = await supabase.from('dispatch_statuses').delete().eq('id', id)
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('foreign key constraint') || message.includes('violates')) {
      throw new Error('settings.dispatches.errors.statusInUse')
    }
    throw error
  }
}
