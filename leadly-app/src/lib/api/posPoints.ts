import { supabase } from '../supabaseClient'
import type { PosPoint } from '../../types/domain'

/** `activeOnly` es lo que separa los dos consumidores: el módulo POS solo
 * opera sobre puntos activos (una mesa fuera de servicio no debe poder
 * abrir cuenta), mientras que el catálogo de Configuración los lista todos
 * para poder reactivarlos. */
export async function listPosPoints(tenantId: string, options?: { activeOnly?: boolean }): Promise<PosPoint[]> {
  let query = supabase.from('pos_points').select('*').eq('tenant_id', tenantId).is('deleted_at', null)
  if (options?.activeOnly) query = query.eq('is_active', true)
  const { data, error } = await query.order('display_order')
  if (error) throw error
  return data
}

export interface PosPointInput {
  name: string
  kind: 'mesa' | 'caja' | 'punto'
}

export async function createPosPoint(tenantId: string, input: PosPointInput): Promise<PosPoint> {
  const { data: existing, error: existingError } = await supabase
    .from('pos_points')
    .select('display_order')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  const { data, error } = await supabase
    .from('pos_points')
    .insert({ ...input, tenant_id: tenantId, display_order: (existing?.display_order ?? -1) + 1 })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updatePosPoint(id: string, input: Partial<PosPointInput & { is_active: boolean }>): Promise<PosPoint> {
  const { data, error } = await supabase.from('pos_points').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Mismo patrón que reorderDispatchStatuses/reorderStages -- un loop de
 * updates por fila, de sobra para la cantidad de puntos que un tenant
 * real vaya a tener. */
export async function reorderPosPoints(orderedIds: string[]): Promise<void> {
  await Promise.all(orderedIds.map((id, index) => supabase.from('pos_points').update({ display_order: index }).eq('id', id)))
}

/** Soft delete -- a diferencia de dispatch_statuses, acá no hay guard de
 * "no borrar el último": cero puntos configurados es un estado válido, la
 * lista de cuentas abiertas del POS simplemente queda sin agrupar. */
export async function deletePosPoint(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('pos_points').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
