import { supabase } from '../supabaseClient'
import type { ContactStage, CrmContact, CrmNote } from '../../types/domain'

export interface ContactInput {
  tenant_id: string
  full_name: string
  phone: string
  email?: string | null
  company?: string | null
  stage: ContactStage
  tags: string[]
}

export async function listContacts(tenantId: string): Promise<CrmContact[]> {
  const { data, error } = await supabase
    .from('crm_contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getContact(id: string): Promise<CrmContact | null> {
  const { data, error } = await supabase.from('crm_contacts').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function createContact(input: ContactInput): Promise<CrmContact> {
  const { data, error } = await supabase.from('crm_contacts').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateContact(id: string, input: Partial<ContactInput>): Promise<CrmContact> {
  const { data, error } = await supabase.from('crm_contacts').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function listNotes(contactId: string): Promise<CrmNote[]> {
  const { data, error } = await supabase
    .from('crm_notes')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createNote(tenantId: string, contactId: string, content: string): Promise<CrmNote> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('crm_notes')
    .insert({ tenant_id: tenantId, contact_id: contactId, content, author_id: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}
