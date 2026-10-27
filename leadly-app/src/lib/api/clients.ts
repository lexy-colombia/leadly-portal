import { supabase } from '../supabaseClient'
import type { Client, Note, TenantDocumentType } from '../../types/domain'

export interface ClientInput {
  tenant_id: string
  full_name: string
  phone_prefix: string
  phone: string
  email?: string | null
  company?: string | null
  document_type?: TenantDocumentType | null
  document_number?: string | null
  dian_document_type_code?: string | null
  applies_withholding?: boolean
  country?: string | null
  notes?: string | null
  is_active?: boolean
  tags: string[]
  assigned_to?: string | null
  credit_enabled?: boolean
  /** { "<definition_id>": valor } -- validado por el trigger de la base. */
  custom_fields?: Record<string, unknown>
}

/** El formulario de cliente (ContactDrawer.tsx) ya no pide `document_type`
 * (lista genérica NIT/CC/CE/RUC/RFC/PASAPORTE/OTRO) por separado -- pedido
 * explícito del usuario 2026-09-09: "se piden tipos de documentos... varias
 * veces". El catálogo DIAN (dian_document_type_code) es el único que se
 * muestra ahora (es el que de verdad hace falta para facturar); esto deriva
 * un valor razonable de `document_type` a partir de esa elección para que
 * ClientPickerCard.tsx/PosReceiptTicket.tsx (que siguen leyendo
 * `document_type` como etiqueta corta en tickets/buscadores) no se queden
 * sin dato. */
export function dianDocumentTypeCodeToGeneric(code: string | null): TenantDocumentType | null {
  switch (code) {
    case '11': // Registro civil
    case '12': // Tarjeta de identidad
    case '13': // Cédula de ciudadanía
    case '91': // NUIP
      return 'CC'
    case '21': // Tarjeta de extranjería
    case '22': // Cédula de extranjería
      return 'CE'
    case '31': // NIT
    case '50': // NIT de otro país
      return 'NIT'
    case '41': // Pasaporte
      return 'PASAPORTE'
    case '42': // Documento de identificación extranjero
      return 'OTRO'
    default:
      return null
  }
}

export interface ClientListRow extends Client {
  /** Último mensaje de WhatsApp de sus conversaciones (lo resuelve el servidor). */
  last_contact_at: string | null
}

export interface ClientsPageParams {
  search?: string
  tag?: string | null
  agentId?: string | null
  customField?: { fieldId: string; operator: string; value: string } | null
  page: number
  pageSize: number
}

/** Listado paginado del CRM: filtros, búsqueda, total y etiquetas disponibles
 * los resuelve el servidor (RPC list_clients_page, migración 20261029150000)
 * -- reemplaza al viejo listClients(tenantId), que bajaba el tenant entero y
 * truncaba a 1000 clientes sin error. */
export async function listClientsPage(params: ClientsPageParams): Promise<{ rows: ClientListRow[]; total: number; allTags: string[] }> {
  const { data, error } = await supabase.rpc('list_clients_page', {
    p_search: params.search?.trim() || null,
    p_tag: params.tag ?? null,
    p_agent: params.agentId ?? null,
    p_cf_field: params.customField?.fieldId ?? null,
    p_cf_operator: params.customField?.operator ?? null,
    p_cf_value: params.customField?.value ?? null,
    p_page: params.page,
    p_page_size: params.pageSize,
  })
  if (error) throw error
  const res = data as { rows: ClientListRow[]; total: number; all_tags: string[] }
  return { rows: res.rows, total: res.total, allTags: res.all_tags }
}

/** Clientes del tenant por teléfono completo (indicativo + número), para
 * reconstruir destinatarios de una campaña sin bajar todos los clientes. */
export async function findClientsByFullPhone(phones: string[]): Promise<Client[]> {
  if (phones.length === 0) return []
  const { data, error } = await supabase.rpc('find_clients_by_full_phone', { p_phones: phones })
  if (error) throw error
  return (data ?? []) as Client[]
}

/** Server-side typeahead search (name or phone) instead of a
 * full-tenant fetch -- used by the "vincular cliente" picker on an inbound
 * WhatsApp conversation (see ChatPanel/LinkClientDrawer), which can't assume
 * a tenant's client list stays small the way categories/brands realistically
 * do. Empty query short-circuits to "most recently updated" instead of
 * matching everything, so the picker isn't empty before the agent types
 * anything. */
export async function searchClients(tenantId: string, query: string, limit = 8): Promise<Client[]> {
  let request = supabase.from('clients').select('*').eq('tenant_id', tenantId).is('deleted_at', null)
  // Se quitan los caracteres que rompen la sintaxis de .or() de PostgREST.
  const term = query.trim().replace(/[,()%*\\]/g, ' ').trim()
  // phone quedó como SOLO el número local (20260904000000_clients_phone_prefix_split.sql)
  // -- se busca también contra phone_prefix para no perder la posibilidad
  // de encontrar un cliente tipeando su indicativo.
  if (term) request = request.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,phone_prefix.ilike.%${term}%`)
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
 * this client keep their history. `listClientsPage`/`getClient` both filter
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
