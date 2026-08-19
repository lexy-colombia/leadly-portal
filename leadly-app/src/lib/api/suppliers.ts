import { supabase } from '../supabaseClient'
import type { Supplier } from '../../types/domain'

export interface SupplierInput {
  tenant_id: string
  name: string
  contact_name?: string | null
  phone?: string | null
  email?: string | null
  notes?: string | null
  is_active?: boolean
}

export async function listSuppliers(tenantId: string): Promise<Supplier[]> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createSupplier(input: SupplierInput): Promise<Supplier> {
  const { data, error } = await supabase.from('suppliers').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateSupplier(id: string, input: Partial<SupplierInput>): Promise<Supplier> {
  const { data, error } = await supabase.from('suppliers').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteSupplier(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('suppliers').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
