// Lets a tenant_admin/tenant_agent generate a real Wompi payment link for
// one of their own confirmed sales orders, straight from the order's own
// screen (PaymentDrawer.tsx) -- the human-agent counterpart to the AI's
// generate_payment_link (whatsapp-ai-tools). Runs server-side only because
// creating the checkout needs the tenant's Vault-stored Wompi secrets; the
// actual authorization (this caller may act on this order) goes through the
// caller's own JWT so RLS enforces tenant isolation exactly like any other
// authenticated request, same pattern as whatsapp-send-human -- no extra
// checks reinvented here. The privileged Wompi/Vault work only happens with
// the admin client, and only after the caller-scoped read above already
// confirmed the order belongs to their own tenant.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { createSalesOrderPaymentLink } from "../_shared/payments/salesOrderPayments.ts";

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

  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { order_id } = body;
  if (!order_id) {
    return json({ error: "order_id is required" }, 400);
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

  // RLS on sales_orders already scopes this to the caller's own tenant -- an
  // order belonging to someone else's tenant simply comes back null here,
  // same as "not found".
  const { data: order } = await callerClient.from("sales_orders").select("id, tenant_id").eq("id", order_id).maybeSingle();
  if (!order) {
    return json({ error: "Order not found" }, 404);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await createSalesOrderPaymentLink(adminClient, order.tenant_id, order.id, caller.id);
    return json({ checkout_url: result.checkoutUrl, amount: result.amount, order_code: result.orderCode });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "No se pudo generar el link de pago." }, 400);
  }
});
