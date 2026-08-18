import { supabase } from '../supabaseClient'
import type { ClientStage, Client, Note } from '../../types/domain'

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
  stage: ClientStage
  tags: string[]
  assigned_to?: string | null
}

export async function listClients(tenantId: string): Promise<Client[]> {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data
}

/** Server-side typeahead search (name or phone) instead of `listClients`'s
 * full-tenant fetch -- used by the "vincular cliente" picker on an inbound
 * WhatsApp conversation (see ChatPanel/LinkClientDrawer), which can't assume
 * a tenant's client list stays small the way categories/brands realistically
 * do. Empty query short-circuits to "most recently updated" instead of
 * matching everything, so the picker isn't empty before the agent types
 * anything. */
export async function searchClients(tenantId: string, query: string, limit = 8): Promise<Client[]> {
  let request = supabase.from('clients').select('*').eq('tenant_id', tenantId).is('deleted_at', null)
  const term = query.trim()
  if (term) request = request.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`)
  const { data, error } = await request.order('updated_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data
}

export async function getClient(id: string): Promise<Client | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data
}

export async function createClient(input: ClientInput): Promise<Client> {
  const { data, error } = await supabase.from('clients').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateClient(id: string, input: Partial<ClientInput>): Promise<Client> {
  const { data, error } = await supabase.from('clients').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Soft delete (see CLAUDE.md section 3) -- stamps deleted_at/deleted_by
 * instead of removing the row, so conversations/notes/etc. that reference
 * this client keep their history. `listClients`/`getClient` both filter
 * `deleted_at is null`, so it just disappears from the CRM. */
export async function deleteClient(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('clients').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

/** Usa `notes` (sin prefijo) -- repunteado 2026-08-17. `crm_notes` se había
 * dropeado sin migrar datos junto con el resto de las tablas crm_*, así que
 * las notas manuales previas a esa fecha se perdieron; la bitácora arranca
 * vacía desde acá en adelante. */
export async function listNotes(clientId: string): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('contact_id', clientId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createNote(tenantId: string, clientId: string, content: string): Promise<Note> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('notes')
    .insert({ tenant_id: tenantId, contact_id: clientId, content, author_id: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}
