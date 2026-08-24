import { supabase } from '../supabaseClient'
import type { ReturnStatus } from '../../types/domain'

export async function listReturnStatuses(tenantId: string): Promise<ReturnStatus[]> {
  const { data, error } = await supabase.from('return_statuses').select('*').eq('tenant_id', tenantId).order('display_order')
  if (error) throw error
  return data
}

export interface ReturnStatusInput {
  name: string
  color: string
  is_terminal: boolean
}

export async function createReturnStatus(tenantId: string, input: ReturnStatusInput): Promise<ReturnStatus> {
  const { data: existing, error: existingError } = await supabase
    .from('return_statuses')
    .select('display_order')
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  const { data, error } = await supabase
    .from('return_statuses')
    .insert({ ...input, tenant_id: tenantId, display_order: (existing?.display_order ?? -1) + 1 })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateReturnStatus(id: string, input: Partial<ReturnStatusInput>): Promise<ReturnStatus> {
  const { data, error } = await supabase.from('return_statuses').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function reorderReturnStatuses(orderedIds: string[]): Promise<void> {
  await Promise.all(orderedIds.map((id, index) => supabase.from('return_statuses').update({ display_order: index }).eq('id', id)))
}

/** Refuses client-side if this is the tenant's last status -- a return
 * ticket always needs somewhere to start. Postgres itself refuses (FK
 * restrict) if the status is still referenced by an existing return. */
export async function deleteReturnStatus(tenantId: string, id: string): Promise<void> {
  const remaining = await listReturnStatuses(tenantId)
  if (remaining.length <= 1) {
    throw new Error('settings.returns.errors.onlyStatus')
  }
  const { error } = await supabase.from('return_statuses').delete().eq('id', id)
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('foreign key constraint') || message.includes('violates')) {
      throw new Error('settings.returns.errors.statusInUse')
    }
    throw error
  }
}
