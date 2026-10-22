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
// payments-api es el UNICO receptor de eventos de Wompi (payment-webhook-wompi
// se retiro). Todo link se crea por este servicio, asi que todo evento se
// resuelve contra payments.payment_links, con la credencial del comercio del
// link. La URL de eventos de CADA cuenta de Wompi en uso (plataforma y cada
// tenant con Wompi propio) debe apuntar a .../functions/v1/payments-api/v1/events/wompi.
// Contrato del receptor para proyectos (firma Payments-Signature, deduplicación
// por Payments-Event-Id, significado de classification / payment_link.status):
// ver README.md en esta carpeta. Un proyecto debe entregar el servicio SOLO con
// classification=processed Y payment_link.status=paid Y transaction.status=APPROVED.
// Secreto requerido en la función: CRON_REMINDER_SECRET (ya usado por
// notify-sales-lead / send-task-reminders).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHandler } from "../_shared/payments-service/router.ts";
import { buildPaymentsDeps } from "../_shared/payments-service/buildPaymentsDeps.ts";

// La construccion de Deps (admin client, credenciales de plataforma/comercio,
// verifyAdmin) vive en _shared/payments-service/buildPaymentsDeps.ts.
const deps = buildPaymentsDeps({
  supabaseUrl: Deno.env.get("SUPABASE_URL")!,
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  anonKey: Deno.env.get("SUPABASE_ANON_KEY")!,
  cronSecret: Deno.env.get("CRON_REMINDER_SECRET") ?? null,
});

Deno.serve(createHandler(deps));
