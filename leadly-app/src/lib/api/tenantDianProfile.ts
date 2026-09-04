import { supabase } from '../supabaseClient'
import type { DianDocumentType, TaxType, TenantDianProfile, TenantWithholdingConfig } from '../../types/domain'

export async function listTaxTypes(): Promise<TaxType[]> {
  const { data, error } = await supabase.from('tax_types').select('*').eq('is_active', true).order('code')
  if (error) throw error
  return data
}

export async function listDianDocumentTypes(): Promise<DianDocumentType[]> {
  const { data, error } = await supabase.from('dian_document_types').select('*').order('code')
  if (error) throw error
  return data
}

export async function getTenantDianProfile(tenantId: string): Promise<TenantDianProfile | null> {
  const { data, error } = await supabase.from('tenant_dian_profile').select('*').eq('tenant_id', tenantId).maybeSingle()
  if (error) throw error
  return data
}

async function ensureTenantDianProfile(tenantId: string): Promise<TenantDianProfile> {
  const existing = await getTenantDianProfile(tenantId)
  if (existing) return existing
  const { data, error } = await supabase.from('tenant_dian_profile').insert({ tenant_id: tenantId }).select().single()
  if (error) throw error
  return data
}

export type TenantDianProfileInput = Partial<
  Pick<
    TenantDianProfile,
    | 'tax_enabled'
    | 'fiscal_regime'
    | 'is_self_withholding_agent'
    | 'city'
    | 'resolution_number'
    | 'resolution_prefix'
    | 'resolution_range_from'
    | 'resolution_range_to'
    | 'resolution_valid_from'
    | 'resolution_valid_until'
    | 'software_id'
    | 'test_set_id'
    | 'webservice_url'
    | 'is_configured'
  >
>

export async function updateTenantDianProfile(tenantId: string, input: TenantDianProfileInput): Promise<TenantDianProfile> {
  const profile = await ensureTenantDianProfile(tenantId)
  const { data, error } = await supabase.from('tenant_dian_profile').update(input).eq('id', profile.id).select().single()
  if (error) throw error
  return data
}

export async function listTenantWithholdingConfigs(tenantId: string): Promise<TenantWithholdingConfig[]> {
  const { data, error } = await supabase
    .from('tenant_withholding_configs')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at')
  if (error) throw error
  return data
}

export async function createTenantWithholdingConfig(
  tenantId: string,
  input: { tax_type_code: string; concept: string; rate: number },
): Promise<TenantWithholdingConfig> {
  const { data, error } = await supabase
    .from('tenant_withholding_configs')
    .insert({ tenant_id: tenantId, ...input })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateTenantWithholdingConfig(
  id: string,
  input: Partial<{ tax_type_code: string; concept: string; rate: number; is_active: boolean }>,
): Promise<TenantWithholdingConfig> {
  const { data, error } = await supabase.from('tenant_withholding_configs').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Soft-delete, mismo criterio que el resto de tablas de negocio con
 * identidad propia (una tarifa de retención configurada es un dato real que
 * conviene poder auditar, no solo desmarcar). */
export async function deleteTenantWithholdingConfig(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('tenant_withholding_configs').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
