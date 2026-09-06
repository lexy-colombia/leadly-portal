import { supabase } from '../supabaseClient'
import type { ExpenseCategory } from '../../types/domain'

export interface ExpenseCategoryInput {
  tenant_id: string
  name: string
  description?: string | null
  color?: string | null
}

export async function listExpenseCategories(tenantId: string): Promise<ExpenseCategory[]> {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createExpenseCategory(input: ExpenseCategoryInput): Promise<ExpenseCategory> {
  const { data, error } = await supabase.from('expense_categories').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateExpenseCategory(id: string, input: Partial<ExpenseCategoryInput>): Promise<ExpenseCategory> {
  const { data, error } = await supabase.from('expense_categories').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteExpenseCategory(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('expense_categories')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}
