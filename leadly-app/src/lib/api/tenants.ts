import { supabase } from '../supabaseClient'
import type { Tenant, TenantDocumentType, TenantEntityType, TenantLanguage, TenantStatus } from '../../types/domain'
import { TENANT_LOGO_ALLOWED_TYPES, TENANT_LOGO_MAX_BYTES } from '../referenceData'

export interface TenantInput {
  name: string
  entity_type: TenantEntityType
  legal_name: string | null
  document_type: TenantDocumentType | null
  document_number: string | null
  contact_email: string | null
  contact_phone: string | null
  country: string | null
  state_province: string | null
  preferred_language: TenantLanguage
  notes: string | null
}

/** Thin, typed wrapper around the `tenants` table -- keeps pages free of raw
 * supabase-js calls/error-shape handling, and gives every future data
 * resource (whatsapp_lines, ai_assistants, ...) the same module shape. */
export async function listTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase.from('tenants').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const { data, error } = await supabase.from('tenants').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function createTenant(input: TenantInput): Promise<Tenant> {
  const { data, error } = await supabase.from('tenants').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateTenant(id: string, input: TenantInput): Promise<Tenant> {
  const { data, error } = await supabase.from('tenants').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function setTenantStatus(id: string, status: TenantStatus): Promise<Tenant> {
  const { data, error } = await supabase.from('tenants').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}

export function validateTenantLogoFile(file: File): string | null {
  if (!TENANT_LOGO_ALLOWED_TYPES.includes(file.type)) return 'El logo debe ser PNG, JPG, WEBP o SVG.'
  if (file.size > TENANT_LOGO_MAX_BYTES) return 'El logo no puede pesar más de 5MB.'
  return null
}

/** Uploads to `tenant-logos/{tenantId}/logo.<ext>` (upsert, so re-uploading
 * replaces the old file at the same path) and saves the resulting public URL
 * on the tenant row. The tenant must already exist -- callers create/update
 * the tenant first, then call this as a follow-up step once they have an id. */
export async function uploadTenantLogo(tenantId: string, file: File): Promise<Tenant> {
  const validationError = validateTenantLogoFile(file)
  if (validationError) throw new Error(validationError)

  const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
  const path = `${tenantId}/logo.${ext}`

  const { error: uploadError } = await supabase.storage.from('tenant-logos').upload(path, file, {
    upsert: true,
    contentType: file.type,
  })
  if (uploadError) throw uploadError

  const { data: publicUrlData } = supabase.storage.from('tenant-logos').getPublicUrl(path)
  // Cache-bust so the new logo shows immediately instead of the browser reusing
  // a cached response for the same path after an upsert.
  const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`

  const { data, error } = await supabase.rpc('set_tenant_logo', { p_tenant_id: tenantId, p_logo_url: logoUrl })
  if (error) throw error
  return data
}
