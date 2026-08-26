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
import { applySalesOrderPaymentWebhookEvent } from "../_shared/payments/salesOrderPayments.ts";
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

  // Not every checkout this project creates is Leadly billing a tenant --
  // a tenant collecting payment from their OWN customer (generate_payment_link/
  // create-sales-order-payment-link) uses this exact same webhook URL, since
  // Wompi only allows one events URL per merchant account and it's that
  // tenant's own Wompi account registered there -- but it tracks its
  // pending checkout in sales_order_payment_links instead of payment_invoices
  // (a payment_invoices row means "Leadly is billing this tenant", the wrong
  // direction for a tenant charging their own customer). Check that table
  // when the invoice lookup misses, before giving up.
  let merchantTenantId: string | null = null;
  let linkRow: { id: string; tenant_id: string } | null = null;
  if (invoiceRow) {
    merchantTenantId = invoiceRow.merchant_tenant_id;
  } else {
    const { data: link } = await adminClient
      .from("sales_order_payment_links")
      .select("id, tenant_id")
      .eq("provider_key", "wompi")
      .eq("provider_checkout_id", event.providerCheckoutId)
      .maybeSingle();
    if (!link) return json({ ok: true });
    linkRow = link;
    merchantTenantId = link.tenant_id;
  }

  let credential;
  try {
    credential = await resolveCredential(adminClient, merchantTenantId, "wompi");
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

  if (invoiceRow) {
    await applyWebhookEvent(adminClient, "wompi", event);
  } else if (linkRow) {
    await applySalesOrderPaymentWebhookEvent(adminClient, "wompi", event.providerCheckoutId, {
      approved: event.approved,
      providerTransactionId: event.providerTransactionId,
      amountCents: event.amountCents,
      paymentReference: event.paymentReference,
    });
  }
  return json({ ok: true });
});
