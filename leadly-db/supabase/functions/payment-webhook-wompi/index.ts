// Wompi's own webhook -- one function per provider (Wompi's dashboard needs
// a fixed URL to point at, it can't be routed dynamically by payload alone).
// A future provider adds its own payment-webhook-<provider> function that
// delegates to the same applyWebhookEvent.ts, nothing here needs to change.
// Public endpoint, deployed with --no-verify-jwt (same pitfall as
// whatsapp-webhook: the flag is not sticky, must be passed on every
// redeploy) -- authenticity instead comes from the HMAC-SHA256 checksum
// Wompi sends on every event.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { applyWebhookEvent } from "../_shared/payments/applyWebhookEvent.ts";
import { makeSecretGetter, resolveCredential } from "../_shared/payments/registry.ts";
import { wompiAdapter } from "../_shared/payments/wompi.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const event = wompiAdapter.parseWebhookEvent(payload);
  if (!event || !event.providerCheckoutId) {
    // Not a transaction.updated event, or one we can't route to an invoice
    // -- acknowledge so Wompi doesn't retry forever.
    return json({ ok: true });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: invoiceRow } = await adminClient
    .from("payment_invoices")
    .select("id, merchant_tenant_id")
    .eq("provider_checkout_id", event.providerCheckoutId)
    .maybeSingle();
  if (!invoiceRow) {
    return json({ ok: true });
  }

  let credential;
  try {
    credential = await resolveCredential(adminClient, invoiceRow.merchant_tenant_id, "wompi");
  } catch (err) {
    console.error("payment-webhook-wompi: could not resolve credential:", err);
    return json({ ok: true });
  }

  const getSecret = makeSecretGetter(adminClient, credential.id);
  const signatureValid = await wompiAdapter.verifyWebhookSignature(payload, getSecret);
  if (!signatureValid) {
    console.error("payment-webhook-wompi: invalid signature");
    return json({ error: "Invalid signature" }, 401);
  }

  await applyWebhookEvent(adminClient, "wompi", event);
  return json({ ok: true });
});
