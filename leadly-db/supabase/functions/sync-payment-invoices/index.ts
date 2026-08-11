// Manual reconciliation, generic across providers (mirrors lexy's
// sync-wompi-invoices) -- a poll-based safety net for missed webhooks, not a
// scheduled retry. Superadmin only, triggered from the backoffice
// "Sincronizar con el proveedor" button. Optionally scoped to a single
// invoice_id.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { applyWebhookEvent } from "../_shared/payments/applyWebhookEvent.ts";
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) {
    return json({ error: "Invalid session" }, 401);
  }

  const { data: isSuperadmin } = await callerClient.rpc("is_superadmin");
  if (!isSuperadmin) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: { invoice_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    // body is optional -- syncs every open invoice when omitted
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  let query = adminClient
    .from("payment_invoices")
    .select("id, merchant_tenant_id, provider_key, provider_checkout_id, status")
    .in("status", ["PENDING", "OVERDUE"])
    .not("provider_checkout_id", "is", null);
  if (body.invoice_id) {
    query = query.eq("id", body.invoice_id);
  }

  const { data: invoices, error: invoicesError } = await query;
  if (invoicesError) {
    return json({ error: invoicesError.message }, 500);
  }

  const results: { invoice_id: string; synced: boolean }[] = [];
  for (const invoice of invoices ?? []) {
    try {
      const adapter = getAdapter(invoice.provider_key);
      const credential = await resolveCredential(adminClient, invoice.merchant_tenant_id, invoice.provider_key);
      const getSecret = makeSecretGetter(adminClient, credential.id);
      const event = await adapter.queryTransaction(credential, getSecret, invoice.provider_checkout_id!);
      const applied = event ? await applyWebhookEvent(adminClient, invoice.provider_key, event) : { handled: false };
      results.push({ invoice_id: invoice.id, synced: applied.handled });
    } catch (err) {
      console.error(`sync-payment-invoices: failed for invoice ${invoice.id}:`, err);
      results.push({ invoice_id: invoice.id, synced: false });
    }
  }

  return json({ results });
});
