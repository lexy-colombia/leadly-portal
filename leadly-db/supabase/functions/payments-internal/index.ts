// payments-internal -- consumidor interno de Leadly del aviso firmado de
// payments-api: acredita pedidos (sales_order_payments) y facturas de plataforma
// (payment_invoices) en una transaccion SQL. Lógica en
// _shared/payments-service/internalConsumer.ts.
//
// Se autentica por Payments-Signature (HMAC con el secreto de firma del cliente
// interno, en Vault), NO por JWT: verify_jwt = false (config.toml).
// DESPLIEGUE (el flag NO es sticky: repetirlo en cada redeploy):
//   supabase functions deploy payments-internal --project-ref kkdtrkfcnyvuefazndnj --no-verify-jwt
// Secreto de función requerido: PAYMENTS_INTERNAL_CLIENT_ID = payments.clients.id del
// cliente kind='internal' cuyo callback_url apunta a esta función.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createInternalHandler } from "../_shared/payments-service/internalConsumer.ts";
import type { RpcClient } from "../_shared/payments-service/types.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(createInternalHandler({
  rpc: admin as unknown as RpcClient,
  now: () => Date.now(),
  clientId: Deno.env.get("PAYMENTS_INTERNAL_CLIENT_ID") ?? null,
}));
