// payments-api -- servicio de links de pago Wompi de Lexy Colombia.
// Router fino: la lógica vive en _shared/payments-service/.
//
// DESPLIEGUE (un solo archivo/función; --no-verify-jwt porque la API key no
// es un JWT y el receptor de Wompi se autentica por checksum):
//   supabase functions deploy payments-api --project-ref kkdtrkfcnyvuefazndnj --no-verify-jwt
// El flag NO es sticky: repetirlo en cada redeploy. config.toml ya declara
// [functions.payments-api] verify_jwt = false.
// Chequeo post-deploy:
//   curl -i https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/payments-api/v1/health        -> 200 {"status":"ok"}
//   curl -i https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/payments-api/v1/payment-links -> 401 con cuerpo
//        {"error":{"code":"unauthorized",...}} (el cuerpo propio, no el del gateway)
// payments-api es el UNICO receptor de eventos de Wompi: payment-webhook-wompi
// se retiro (sus dos origenes -- factura de plataforma y link de pedido de un
// tenant -- los resuelve _shared/payments-service/legacyOrigins.ts). La URL de
// eventos de CADA cuenta de Wompi en uso (plataforma y cada tenant con Wompi
// propio) debe apuntar a .../functions/v1/payments-api/v1/events/wompi.
// Contrato del receptor para proyectos (firma Payments-Signature, deduplicación
// por Payments-Event-Id, significado de classification / payment_link.status):
// ver README.md en esta carpeta. Un proyecto debe entregar el servicio SOLO con
// classification=processed Y payment_link.status=paid Y transaction.status=APPROVED.
// Secreto requerido en la función: CRON_REMINDER_SECRET (ya usado por
// notify-sales-lead / send-task-reminders).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { makeSecretGetter, resolveCredential } from "../_shared/payments/registry.ts";
import { createHandler } from "../_shared/payments-service/router.ts";
import { createLegacyStore } from "../_shared/payments-service/legacyStore.ts";
import { ApiError } from "../_shared/payments-service/errors.ts";
import { publicAppUrl } from "../_shared/publicAppUrl.ts";
import type { Deps, RpcClient } from "../_shared/payments-service/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const adminClient = createClient(supabaseUrl, serviceRoleKey);

const deps: Deps = {
  rpc: adminClient as unknown as RpcClient,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  env: { supabaseUrl, cronSecret: Deno.env.get("CRON_REMINDER_SECRET") ?? null, appBaseUrl: publicAppUrl() },
  getPlatformCredential: async () => {
    try {
      const credential = await resolveCredential(adminClient, null, "wompi");
      return { mode: credential.mode, getSecret: makeSecretGetter(adminClient, credential.id) };
    } catch {
      return null;
    }
  },
  // Origenes legacy: public.payment_invoices (Lexy cobra a un tenant) y
  // public.sales_order_payment_links (un tenant cobra a su cliente).
  legacy: createLegacyStore(adminClient),
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

Deno.serve(createHandler(deps));
