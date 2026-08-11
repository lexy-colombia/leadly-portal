import { supabase } from '../supabaseClient'
import type { CrmProductCategory } from '../../types/domain'

export interface ProductCategoryInput {
  tenant_id: string
  name: string
  description?: string | null
  color?: string | null
}

export async function listProductCategories(tenantId: string): Promise<CrmProductCategory[]> {
  const { data, error } = await supabase
    .from('crm_product_categories')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createProductCategory(input: ProductCategoryInput): Promise<CrmProductCategory> {
  const { data, error } = await supabase.from('crm_product_categories').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateProductCategory(id: string, input: Partial<ProductCategoryInput>): Promise<CrmProductCategory> {
  const { data, error } = await supabase.from('crm_product_categories').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteProductCategory(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('crm_product_categories')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}
