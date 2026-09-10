import { supabase } from '../supabaseClient'
import type { DianDocumentType, TaxType, TenantDianProfile, TenantWithholdingConfig } from '../../types/domain'

export interface DianNumberingRange {
  resolutionNumber: string | null
  prefix: string | null
  rangeFrom: number | null
  rangeTo: number | null
  validFrom: string | null
  validUntil: string | null
  technicalKey: string | null
}

export interface SyncDianNumberingRangeResult {
  ranges: DianNumberingRange[]
  responseBody: string
  faultReason: string | null
  operationDescription: string | null
}

/** Botón "Sincronizar con la DIAN" del drawer de Integraciones -- consulta
 * GetNumberingRange (dian-submit, acción `sync_dian_numbering_range`) y
 * devuelve las resoluciones vigentes que encontró, sin escribir nada en
 * tenant_dian_profile -- el caller (DianDirectoCredentialDrawer) decide
 * qué hacer con el resultado (precargar el formulario) y sigue haciendo
 * falta "Guardar cambios" para persistirlo. */
export async function syncDianNumberingRange(tenantId: string): Promise<SyncDianNumberingRangeResult> {
  const { data, error } = await supabase.functions.invoke<SyncDianNumberingRangeResult & { error?: string }>('dian-submit', {
    body: { action: 'sync_dian_numbering_range', tenant_id: tenantId },
  })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const body = await context.json()
        specificMessage = body?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  return { ranges: data?.ranges ?? [], responseBody: data?.responseBody ?? '', faultReason: data?.faultReason ?? null, operationDescription: data?.operationDescription ?? null }
}

export async function listTaxTypes(): Promise<TaxType[]> {
  const { data, error } = await supabase.from('tax_types').select('*').eq('is_active', true).order('code')
  if (error) throw error
  return data
}

export async function listDianDocumentTypes(): Promise<DianDocumentType[]> {
  const { data, error } = await supabase.from('document_types').select('*').order('code')
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
    | 'city_code'
    | 'state_code'
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
    | 'credit_note_prefix'
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
