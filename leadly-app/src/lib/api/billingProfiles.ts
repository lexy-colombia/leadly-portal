import { supabase } from '../supabaseClient'
import type { ClientBillingProfile } from '../../types/domain'

/** Datos editables de un perfil. `tenant_id` lo exige la RLS de inserción;
 * NO es una decisión de negocio del frontend (el servidor valida pertenencia
 * del cliente al tenant con la FK compuesta). */
export interface BillingProfileInput {
  label?: string
  document_type_code: string | null
  document_number: string | null
  legal_name: string | null
  email: string | null
  phone?: string | null
  organization_type: '1' | '2'
  tax_level_code: string
  tax_scheme_code: '01' | '04' | 'ZA' | 'ZZ' | null
  applies_withholding: boolean
  delivery_method?: 'email' | 'print'
  address_line1: string | null
  address_line2?: string | null
  country: string | null
  state_code: string | null
  city_code: string | null
  state_province: string | null
  city: string | null
}

export const BILLING_PROFILES_PAGE_SIZE = 8

/** Página de perfiles vivos de un cliente (predeterminado primero), con total
 * exacto -- `.range()` en el servidor, igual que el resto de listados. */
export async function listBillingProfilesPage(
  clientId: string,
  page: number,
  pageSize = BILLING_PROFILES_PAGE_SIZE,
): Promise<{ rows: ClientBillingProfile[]; total: number }> {
  const from = (page - 1) * pageSize
  const { data, error, count } = await supabase
    .from('client_billing_profiles')
    .select('*', { count: 'exact' })
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: data ?? [], total: count ?? 0 }
}

/** Perfiles para un selector «Facturar a». Una sola página de hasta 50: un
 * cliente real tiene un puñado de razones sociales; el tope es explícito, no
 * un corte silencioso (el total viaja en `total`). */
export async function listBillingProfilesForPicker(clientId: string): Promise<{ rows: ClientBillingProfile[]; total: number }> {
  return listBillingProfilesPage(clientId, 1, 50)
}

export async function getBillingProfile(id: string): Promise<ClientBillingProfile | null> {
  const { data, error } = await supabase.from('client_billing_profiles').select('*').eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data
}

export async function createBillingProfile(tenantId: string, clientId: string, input: BillingProfileInput): Promise<ClientBillingProfile> {
  const { data, error } = await supabase
    .from('client_billing_profiles')
    .insert({ ...input, tenant_id: tenantId, client_id: clientId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateBillingProfile(id: string, input: Partial<BillingProfileInput>): Promise<ClientBillingProfile> {
  const { data, error } = await supabase.from('client_billing_profiles').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Soft-delete (deleted_at/deleted_by), como el resto de tablas de negocio. */
export async function deleteBillingProfile(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('client_billing_profiles')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}

/** Marca un perfil como el predeterminado de su cliente (RPC atómica; el
 * tenant lo resuelve la RLS, nunca viaja por parámetro). */
export async function setDefaultBillingProfile(id: string): Promise<ClientBillingProfile> {
  const { data, error } = await supabase.rpc('set_default_billing_profile', { p_profile_id: id })
  if (error) throw error
  return data as ClientBillingProfile
}
