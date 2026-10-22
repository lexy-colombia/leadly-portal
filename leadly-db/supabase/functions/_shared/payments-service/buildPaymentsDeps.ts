// Construccion de `Deps` del servicio de pagos sobre supabase-js (service role).
// Compartido por payments-api y por los creadores internos que llaman
// createPaymentLink en proceso (sin API key ni HTTP). Nada de esto toca la red
// hasta que se usa una dependencia.
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { makeSecretGetter, resolveCredential } from "../payments/registry.ts";
import { ApiError } from "./errors.ts";
import { publicAppUrl } from "../publicAppUrl.ts";
import type { Deps, PlatformCredential, RpcClient } from "./types.ts";

/** Credencial Wompi ACTIVA de un comercio (tenant) o de la plataforma (null).
 * Devuelve null si no hay una activa o no se pudo resolver: el llamante falla cerrado. */
export function makeMerchantCredentialGetter(admin: SupabaseClient) {
  return async (tenantId: string | null): Promise<PlatformCredential | null> => {
    try {
      const credential = await resolveCredential(admin, tenantId, "wompi");
      return { mode: credential.mode, getSecret: makeSecretGetter(admin, credential.id) };
    } catch {
      return null;
    }
  };
}

export interface BuildDepsOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
  cronSecret?: string | null;
}

export function buildPaymentsDeps(opts: BuildDepsOptions): Deps {
  const { supabaseUrl, serviceRoleKey, anonKey } = opts;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const getMerchantCredential = makeMerchantCredentialGetter(adminClient);
  return {
    rpc: adminClient as unknown as RpcClient,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    env: { supabaseUrl, cronSecret: opts.cronSecret ?? null, appBaseUrl: publicAppUrl() },
    getPlatformCredential: () => getMerchantCredential(null),
    getMerchantCredential,
    isMerchantActive: async (tenantId) => {
      const { data, error } = await adminClient.from("tenants").select("status").eq("id", tenantId).maybeSingle();
      return !error && data?.status === "active";
    },
    verifyAdmin: async (authHeader) => {
      if (!authHeader) throw new ApiError(401, "unauthorized", "Falta la sesión.");
      const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error } = await caller.auth.getUser();
      if (error || !user) throw new ApiError(401, "unauthorized", "Sesión inválida.");
      const { data: profile } = await caller.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (!profile || profile.role !== "superadmin") throw new ApiError(403, "forbidden", "Solo un superadministrador puede usar esta ruta.");
      return { userId: user.id };
    },
    // Best-effort: si el runtime no expone Deno.resolveDns, el anti-SSRF solo mira literales.
    resolveDns: typeof Deno.resolveDns === "function"
      ? async (host: string) => {
        const [a, aaaa] = await Promise.allSettled([Deno.resolveDns(host, "A"), Deno.resolveDns(host, "AAAA")]);
        return [...(a.status === "fulfilled" ? a.value : []), ...(aaaa.status === "fulfilled" ? aaaa.value : [])];
      }
      : undefined,
  };
}
