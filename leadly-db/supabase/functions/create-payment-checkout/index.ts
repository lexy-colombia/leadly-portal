// Creates (or reuses) a hosted checkout for a pending payment_invoices row.
// Authorization mirrors whatsapp-send-human: the caller's own JWT decides
// what they can even see (RLS on payment_invoices scopes SELECT to
// payer_tenant_id = their tenant, or superadmin) -- once that's confirmed,
// the actual provider call and the write-back of provider_checkout_id use
// the service-role admin client, since payment_invoices writes are
// superadmin/service_role-only by RLS and the credential secret can only be
// read by service_role (see get_payment_credential_secret).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getAdapter, makeSecretGetter, resolveCredential } from "../_shared/payments/registry.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  let body: { invoice_id?: string; redirect_url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { invoice_id, redirect_url } = body;
  if (!invoice_id) {
    return json({ error: "invoice_id is required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) {
    return json({ error: "Invalid session" }, 401);
  }

  const { data: invoice } = await callerClient
    .from("payment_invoices")
    .select("id, merchant_tenant_id, provider_key, amount_cents, currency, description, status, provider_checkout_id, invoice_number")
    .eq("id", invoice_id)
    .maybeSingle();

  if (!invoice) {
    return json({ error: "Invoice not found" }, 404);
  }
  if (!["PENDING", "OVERDUE"].includes(invoice.status)) {
    return json({ error: "La factura no está pendiente de pago" }, 400);
  }

  const adapter = getAdapter(invoice.provider_key);

  if (invoice.provider_checkout_id) {
    return json({ checkoutUrl: adapter.checkoutUrlFor(invoice.provider_checkout_id) });
  }

  try {
    const credential = await resolveCredential(adminClient, invoice.merchant_tenant_id, invoice.provider_key);
    const getSecret = makeSecretGetter(adminClient, credential.id);

    const result = await adapter.createCheckout(credential, getSecret, {
      invoiceId: invoice.id,
      amountCents: invoice.amount_cents,
      currency: invoice.currency,
      description: invoice.description ?? `Factura ${invoice.invoice_number ?? invoice.id}`,
      redirectUrl: redirect_url,
    });

    await adminClient.from("payment_invoices").update({ provider_checkout_id: result.providerCheckoutId }).eq("id", invoice.id);

    return json({ checkoutUrl: result.checkoutUrl });
  } catch (err) {
    console.error("create-payment-checkout error:", err);
    return json({ error: err instanceof Error ? err.message : "No se pudo crear el checkout de pago" }, 502);
  }
});
