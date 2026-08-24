import { supabase } from '../supabaseClient'
import type { ReturnResolutionEffect, ReturnResolutionType } from '../../types/domain'

export async function listReturnResolutionTypes(tenantId: string): Promise<ReturnResolutionType[]> {
  const { data, error } = await supabase.from('return_resolution_types').select('*').eq('tenant_id', tenantId).order('display_order')
  if (error) throw error
  return data
}

export interface ReturnResolutionTypeInput {
  name: string
  effect: ReturnResolutionEffect
  is_active: boolean
}

export async function createReturnResolutionType(tenantId: string, input: ReturnResolutionTypeInput): Promise<ReturnResolutionType> {
  const { data: existing, error: existingError } = await supabase
    .from('return_resolution_types')
    .select('display_order')
    .eq('tenant_id', tenantId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  const { data, error } = await supabase
    .from('return_resolution_types')
    .insert({ ...input, tenant_id: tenantId, display_order: (existing?.display_order ?? -1) + 1 })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateReturnResolutionType(id: string, input: Partial<ReturnResolutionTypeInput>): Promise<ReturnResolutionType> {
  const { data, error } = await supabase.from('return_resolution_types').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function reorderReturnResolutionTypes(orderedIds: string[]): Promise<void> {
  await Promise.all(orderedIds.map((id, index) => supabase.from('return_resolution_types').update({ display_order: index }).eq('id', id)))
}

/** Nunca se borra de verdad -- una vez usado por un ticket, sales_orders.id
 * queda estable si algún return.resolution_type_id ya lo referencia (on
 * delete restrict). "Eliminar" acá es apagar is_active, así deja de
 * ofrecerse en tickets nuevos sin romper el historial de los que ya lo
 * usaron. */
export async function deactivateReturnResolutionType(id: string): Promise<void> {
  const { error } = await supabase.from('return_resolution_types').update({ is_active: false }).eq('id', id)
  if (error) throw error
}
