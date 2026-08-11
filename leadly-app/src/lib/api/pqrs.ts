import { supabase } from '../supabaseClient'
import type { CrmPqr, PqrStatus, PqrType } from '../../types/domain'

export async function listPqrsForContact(contactId: string): Promise<CrmPqr[]> {
  const { data, error } = await supabase
    .from('crm_pqrs')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createPqr(
  tenantId: string,
  contactId: string,
  input: { type: PqrType; subject: string; description: string },
): Promise<CrmPqr> {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('crm_pqrs')
    .insert({
      tenant_id: tenantId,
      contact_id: contactId,
      type: input.type,
      subject: input.subject,
      description: input.description || null,
      created_by: user?.id ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updatePqrStatus(id: string, status: PqrStatus): Promise<CrmPqr> {
  const { data, error } = await supabase.from('crm_pqrs').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}
