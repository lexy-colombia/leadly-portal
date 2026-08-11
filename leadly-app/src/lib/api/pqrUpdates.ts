import { supabase } from '../supabaseClient'
import type { CrmPqrUpdate } from '../../types/domain'

export async function listPqrUpdates(pqrId: string): Promise<CrmPqrUpdate[]> {
  const { data, error } = await supabase
    .from('crm_pqr_updates')
    .select('*')
    .eq('pqr_id', pqrId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createPqrUpdate(tenantId: string, pqrId: string, content: string): Promise<CrmPqrUpdate> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('crm_pqr_updates')
    .insert({ tenant_id: tenantId, pqr_id: pqrId, content, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}
