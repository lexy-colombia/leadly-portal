// Creates (or reuses) a hosted checkout for a pending payment_invoices row,
// THROUGH the unified payments service (in-process, as Leadly's internal client,
// merchant = the invoice's merchant: the platform, null, for Lexy's own billing).
// Authorization mirrors whatsapp-send-human: the caller's own JWT decides
// what they can even see (RLS on payment_invoices scopes SELECT to
// payer_tenant_id = their tenant, or superadmin) -- once that's confirmed,
// the link creation and the write-back of payments_link_id use the service
// role (payment_invoices writes are superadmin/service_role-only by RLS).
// The link <-> invoice bridge and the tax (from the row) live in _shared/payments/invoiceCheckout.ts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { ensureInvoiceCheckout } from "../_shared/payments/invoiceCheckout.ts";

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
    .select("id, merchant_tenant_id, payer_tenant_id, provider_key, amount_cents, currency, description, status, payments_link_id, invoice_number, tax_rate, tax_cents, period_start, period_end, deleted_at")
    .eq("id", invoice_id)
    .maybeSingle();

  if (!invoice) {
    return json({ error: "Comprobante no encontrado" }, 404);
  }
  // Anulado (soft-delete): RLS no lo oculta y su status sigue PENDING/OVERDUE; cobrarlo dejaria un pago sin acreditar.
  if (invoice.deleted_at) {
    return json({ error: "Este comprobante fue anulado." }, 409);
  }
  if (!["PENDING", "OVERDUE"].includes(invoice.status)) {
    return json({ error: "El comprobante no está pendiente de pago" }, 400);
  }

  try {
    const result = await ensureInvoiceCheckout(adminClient, invoice, caller.id, redirect_url);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ checkoutUrl: result.checkoutUrl });
  } catch (err) {
    console.error("create-payment-checkout error:", err);
    return json({ error: err instanceof Error ? err.message : "No se pudo crear el checkout de pago" }, 502);
  }
});
