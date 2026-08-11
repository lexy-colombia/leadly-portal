import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { PaymentCredential, PaymentProviderAdapter, SecretGetter } from "./types.ts";
import { wompiAdapter } from "./wompi.ts";

const ADAPTERS: Record<string, PaymentProviderAdapter> = {
  wompi: wompiAdapter,
};

export function getAdapter(providerKey: string): PaymentProviderAdapter {
  const adapter = ADAPTERS[providerKey];
  if (!adapter) throw new Error(`No payment adapter registered for provider "${providerKey}"`);
  return adapter;
}

// merchantTenantId null resolves the platform-level credential (Leadly is
// the merchant, today's only real consumer); non-null resolves that
// tenant's own credential (for when a tenant bills its own end customers --
// schema-ready, no caller uses this path yet).
export async function resolveCredential(
  adminClient: SupabaseClient,
  merchantTenantId: string | null,
  providerKey: string,
): Promise<PaymentCredential> {
  let query = adminClient
    .from("tenant_payment_credentials")
    .select("id, provider_key, mode, config")
    .eq("provider_key", providerKey)
    .eq("is_active", true)
    .is("deleted_at", null);
  query = merchantTenantId ? query.eq("tenant_id", merchantTenantId) : query.is("tenant_id", null);

  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    throw new Error(`No active "${providerKey}" credential configured for ${merchantTenantId ? `tenant ${merchantTenantId}` : "the platform"}`);
  }
  return { id: data.id, providerKey: data.provider_key, mode: data.mode, config: data.config ?? {} };
}

export function makeSecretGetter(adminClient: SupabaseClient, credentialId: string): SecretGetter {
  return async (secretName: string) => {
    const { data, error } = await adminClient.rpc("get_payment_credential_secret", {
      p_credential_id: credentialId,
      p_secret_name: secretName,
    });
    if (error) throw error;
    return (data as string | null) ?? null;
  };
}
