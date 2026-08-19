import { supabase } from '../supabaseClient'
import type { Warehouse, WarehouseType } from '../../types/domain'

export interface WarehouseInput {
  tenant_id: string
  name: string
  address?: string | null
  city?: string | null
  type?: WarehouseType
  manager_name?: string | null
  phone?: string | null
  is_default?: boolean
  is_active?: boolean
}

export async function listWarehouses(tenantId: string): Promise<Warehouse[]> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('is_default', { ascending: false })
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createWarehouse(input: WarehouseInput): Promise<Warehouse> {
  const { data, error } = await supabase.from('warehouses').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateWarehouse(id: string, input: Partial<WarehouseInput>): Promise<Warehouse> {
  const { data, error } = await supabase.from('warehouses').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteWarehouse(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('warehouses').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
