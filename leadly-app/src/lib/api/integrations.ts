import { supabase } from '../supabaseClient'
import type { IntegrationCredential, IntegrationProvider } from '../../types/domain'

export async function listIntegrationProviders(): Promise<IntegrationProvider[]> {
  const { data, error } = await supabase.from('integration_providers').select('*').order('name')
  if (error) throw error
  return data
}

/** null tenantId reads/writes the platform-level credential (Leadly's own
 * account with this provider); a tenant id reads/writes that tenant's own. */
export async function getIntegrationCredential(providerKey: string, tenantId: string | null): Promise<IntegrationCredential | null> {
  let query = supabase
    .from('integration_credentials')
    .select('*')
    .eq('provider_key', providerKey)
    .is('deleted_at', null)
  query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data
}

async function ensureIntegrationCredential(providerKey: string, tenantId: string | null): Promise<IntegrationCredential> {
  const existing = await getIntegrationCredential(providerKey, tenantId)
  if (existing) return existing
  const { data, error } = await supabase
    .from('integration_credentials')
    .insert({ provider_key: providerKey, tenant_id: tenantId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function setIntegrationCredentialMode(providerKey: string, tenantId: string | null, mode: 'sandbox' | 'production'): Promise<void> {
  const credential = await ensureIntegrationCredential(providerKey, tenantId)
  const { error } = await supabase.from('integration_credentials').update({ mode }).eq('id', credential.id)
  if (error) throw error
}

export async function setIntegrationCredentialConfig(providerKey: string, tenantId: string | null, config: Record<string, unknown>): Promise<void> {
  const credential = await ensureIntegrationCredential(providerKey, tenantId)
  const { error } = await supabase.from('integration_credentials').update({ config }).eq('id', credential.id)
  if (error) throw error
}

export async function setIntegrationCredentialSecret(providerKey: string, tenantId: string | null, secretName: string, secretValue: string): Promise<void> {
  const credential = await ensureIntegrationCredential(providerKey, tenantId)
  const { error } = await supabase.rpc('set_integration_credential_secret', {
    p_credential_id: credential.id,
    p_secret_name: secretName,
    p_secret_value: secretValue,
  })
  if (error) throw error
}

export async function getIntegrationCredentialConfiguredSecrets(credentialId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('integration_credential_configured_secrets', { p_credential_id: credentialId })
  if (error) throw error
  return (data as string[]) ?? []
}
