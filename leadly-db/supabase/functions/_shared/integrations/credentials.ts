// Generic credential resolution for the `integration_credentials` module
// (20260811000013), mirroring _shared/payments/registry.ts's
// resolveCredential/makeSecretGetter -- but for HubSpot/Shopify/etc instead
// of payment providers. Always resolves the *tenant's own* credential (never
// the platform-level one, tenant_id null): these are the tenant's own
// external accounts, used on their behalf during their own conversations.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface IntegrationCredential {
  id: string;
  providerKey: string;
  config: Record<string, unknown>;
}

export type SecretGetter = (secretName: string) => Promise<string | null>;

export async function resolveTenantIntegrationCredential(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  providerKey: string,
): Promise<IntegrationCredential> {
  const { data, error } = await adminClient
    .from("integration_credentials")
    .select("id, provider_key, config")
    .eq("tenant_id", tenantId)
    .eq("provider_key", providerKey)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Este tenant no tiene "${providerKey}" conectado en Integraciones.`);
  }
  return { id: data.id, providerKey: data.provider_key, config: data.config ?? {} };
}

// deno-lint-ignore no-explicit-any
export function makeIntegrationSecretGetter(adminClient: any, credentialId: string): SecretGetter {
  return async (secretName: string) => {
    const { data, error } = await adminClient.rpc("get_integration_credential_secret", {
      p_credential_id: credentialId,
      p_secret_name: secretName,
    });
    if (error) throw error;
    return (data as string | null) ?? null;
  };
}
