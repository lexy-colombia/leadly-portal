/** Envío de facturas electrónicas a la DIAN por web service SOAP -- Fase 2,
 * pipeline completo: CUFE, firma XAdES-EPES (signInvoiceXml.ts), ZIP
 * (zip.ts), firma WS-Security del sobre SOAP (wsSecuritySoap.ts) y envío
 * por mTLS (sendToDian.ts / sendInvoiceToDian.ts). Formato de transporte
 * confirmado en vivo contra el ambiente real de habilitación: SOAP plano
 * (`application/soap+xml`, ZIP en base64 inline), NO MTOM -- esa variante
 * dio 415. Sin Basic Auth -- no dio 401, no parece hacer falta.
 *
 * Dos acciones, dos modelos de autorización distintos:
 * - `send_test_invoice`: documento sintético, solo para probar
 *   config/certificado -- interno, mismo patrón que whatsapp-ai-respond,
 *   solo acepta SUPABASE_SERVICE_ROLE_KEY (o DIAN_SUBMIT_TEST_TOKEN, ver
 *   abajo).
 * - `send_invoice`: factura REAL ya reservada por queueInvoiceGeneration --
 *   la llama el propio tenant desde la app, mismo patrón que
 *   whatsapp-send-human (JWT del caller, no admin, RLS de sales_invoices
 *   hace el aislamiento por tenant), pero además restringido a
 *   tenant_admin/superadmin -- es una acción con efecto fiscal real, no
 *   algo que un tenant_agent deba poder disparar. */

// DEBE ser el primer import del archivo -- xmldsigjs (importado
// transitivamente por sendToDian.ts/sendInvoiceToDian.ts) depende de
// pkijs, cuyo auto-init de módulo (`initCryptoEngine()`) crashea en el
// runtime real de Edge Functions si no se neutraliza el polyfill de
// `process` ANTES de que cualquier módulo llegue a importar pkijs -- ver
// el comentario grande en nodeCompatShim.ts para el porqué exacto.
import "../_shared/invoicing/nodeCompatShim.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendTestInvoiceToDian } from "../_shared/invoicing/sendToDian.ts";
import { sendInvoiceToDian } from "../_shared/invoicing/sendInvoiceToDian.ts";
import { createInvoiceAttempt } from "../_shared/invoicing/queueInvoiceGeneration.ts";
import { corsHeaders } from "../_shared/cors.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  // Mismo bug de CORS que calculate-order -- el botón "Enviar a la DIAN"
  // del portal llama esto directo desde el navegador, que exige el
  // preflight OPTIONS. Corregido en el mismo momento (2026-09-03).
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: { tenant_id?: string; invoice_id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (body.action === "send_invoice" || body.action === "retry_invoice") {
    return await handleSendInvoice(req, body, body.action === "retry_invoice");
  }

  return await handleSendTestInvoice(req, body);
});

async function handleSendTestInvoice(req: Request, body: { tenant_id?: string; action?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // DIAN_SUBMIT_TEST_TOKEN: bypass temporal solo para probar manualmente
  // por curl mientras se desarrollaba esto -- TODO sacarlo en cuanto exista
  // un caller real (cron/RPC) que sí tenga el service role key.
  const testToken = Deno.env.get("DIAN_SUBMIT_TEST_TOKEN") ?? "";
  const authorized = authHeader === `Bearer ${serviceRoleKey}` || (testToken && authHeader === `Bearer ${testToken}`);
  if (!authorized) return jsonResponse({ error: "unauthorized" }, 401);

  if (body.action !== "send_test_invoice" || !body.tenant_id) {
    return jsonResponse({ error: "expected_action_send_test_invoice_with_tenant_id" }, 400);
  }

  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey);
  try {
    const result = await sendTestInvoiceToDian(adminClient, body.tenant_id);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 500);
  }
}

async function handleSendInvoice(req: Request, body: { invoice_id?: string }, isRetry = false): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.invoice_id) return jsonResponse({ error: "expected_invoice_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return jsonResponse({ error: "Invalid session" }, 401);

  const { data: profile } = await callerClient.from("profiles").select("role, tenant_id").eq("id", caller.id).maybeSingle();
  if (!profile || (profile.role !== "tenant_admin" && profile.role !== "superadmin")) {
    return jsonResponse({ error: "Solo un administrador del tenant puede enviar facturas a la DIAN." }, 403);
  }

  // RLS de sales_invoices ya aísla por tenant -- si la factura es de otro
  // tenant, esto simplemente viene null, igual que "no existe".
  const { data: invoiceRow } = await callerClient
    .from("sales_invoices")
    .select("id, tenant_id, order_id, status, attempt_number")
    .eq("id", body.invoice_id)
    .maybeSingle();
  if (!invoiceRow) return jsonResponse({ error: "Factura no encontrada." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // No se transmite un documento fiscal real de una venta que todavía no
  // está cobrada del todo -- pedido explícito del usuario 2026-09-04. Este
  // es el candado real (el frontend ya deshabilita el botón como UX, pero
  // esto rechaza igual si alguien llama la función directo). Aplica tanto
  // al primer envío como a un reintento.
  const { data: orderRow } = await adminClient.from("sales_orders").select("total, currency").eq("id", invoiceRow.order_id).maybeSingle();
  const { data: payments } = await adminClient.from("sales_order_payments").select("amount").eq("order_id", invoiceRow.order_id).is("deleted_at", null);
  const totalPaid = (payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  const balance = Math.max(0, (orderRow?.total ?? 0) - totalPaid);
  if (balance > 0) {
    const formatted = new Intl.NumberFormat("es-CO", { style: "currency", currency: orderRow?.currency ?? "COP", maximumFractionDigits: 0 }).format(balance);
    return jsonResponse({ error: `No se puede enviar a la DIAN mientras el pedido tenga saldo pendiente (${formatted}).` }, 409);
  }

  // Reintento: NUNCA se reescribe el intento fallido -- se crea una fila
  // nueva con attempt_number+1 y se envía ésa, tal como fue diseñada la
  // tabla ("el reintento es una fila nueva... auditoría legal completa", ver
  // 20260903110000_sales_invoices.sql). El índice único parcial
  // `sales_invoices_order_id_live_idx` sólo tolera un intento vivo por
  // pedido, así que esto únicamente puede proceder si el anterior quedó en
  // 'rejected'/'error' -- se valida acá para dar un mensaje claro en vez de
  // dejar que reviente como violación de índice.
  let invoiceIdToSend = body.invoice_id;
  if (isRetry) {
    if (invoiceRow.status !== "rejected" && invoiceRow.status !== "error") {
      return jsonResponse(
        { error: `Esta factura está en estado "${invoiceRow.status}"; sólo se puede reintentar una rechazada por la DIAN o con error de envío.` },
        409,
      );
    }
    const { data: attempts } = await adminClient
      .from("sales_invoices")
      .select("attempt_number")
      .eq("order_id", invoiceRow.order_id)
      .order("attempt_number", { ascending: false })
      .limit(1);
    const nextAttempt = (attempts?.[0]?.attempt_number ?? invoiceRow.attempt_number) + 1;

    try {
      const attempt = await createInvoiceAttempt(adminClient, invoiceRow.tenant_id, invoiceRow.order_id, nextAttempt);
      // Si el intento nuevo nace bloqueado, el problema son los datos del
      // cliente, no la DIAN -- mandarlo igual sólo produciría otro rechazo.
      // La fila ya quedó creada con el detalle de qué falta, así que la card
      // lo muestra igual al refrescar.
      if (attempt.status === "blocked_missing_buyer_data") {
        return jsonResponse({ error: attempt.statusDetail ?? "Faltan datos fiscales del cliente para reintentar." }, 409);
      }
      invoiceIdToSend = attempt.invoiceId;
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  try {
    const result = await sendInvoiceToDian(adminClient, invoiceRow.tenant_id, invoiceIdToSend);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
