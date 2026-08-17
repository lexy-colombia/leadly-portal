import { supabase } from '../supabaseClient'
import type { ContactStage, Client, CrmNote } from '../../types/domain'

export interface ClientInput {
  tenant_id: string
  full_name: string
  phone: string
  email?: string | null
  company?: string | null
  nit?: string | null
  industry?: string | null
  website?: string | null
  address?: string | null
  city?: string | null
  notes?: string | null
  is_active?: boolean
  stage: ContactStage
  tags: string[]
  assigned_to?: string | null
}

export async function listContacts(tenantId: string): Promise<Client[]> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getContact(id: string): Promise<Client | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data
}

export async function createContact(input: ClientInput): Promise<Client> {
  const { data, error } = await supabase.from('clients').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateContact(id: string, input: Partial<ClientInput>): Promise<Client> {
  const { data, error } = await supabase.from('clients').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Soft delete (see CLAUDE.md section 3) -- stamps deleted_at/deleted_by
 * instead of removing the row, so conversations/notes/etc. that reference
 * this client keep their history. `listContacts`/`getContact` both filter
 * `deleted_at is null`, so it just disappears from the CRM. */
export async function deleteContact(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('clients').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

/** ROTO a propósito desde 2026-08-17: crm_notes se borró junto con el resto
 * de las tablas crm_* -- el usuario aceptó explícitamente perder las notas
 * manuales de la pestaña "Actividad" al pedir ese borrado. No se arregla acá. */
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
