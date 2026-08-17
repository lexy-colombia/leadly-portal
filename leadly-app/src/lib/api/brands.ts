import { supabase } from '../supabaseClient'
import type { Brand } from '../../types/domain'

export interface BrandInput {
  tenant_id: string
  name: string
  is_active?: boolean
}

export async function listBrands(tenantId: string): Promise<Brand[]> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createBrand(input: BrandInput): Promise<Brand> {
  const { data, error } = await supabase.from('brands').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateBrand(id: string, input: Partial<BrandInput>): Promise<Brand> {
  const { data, error } = await supabase.from('brands').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteBrand(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('brands').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
