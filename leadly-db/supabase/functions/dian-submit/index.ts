/** Envío de facturas electrónicas a la DIAN por web service SOAP -- Fase 2,
 * pipeline completo: CUFE, firma XAdES-EPES (signInvoiceXml.ts), ZIP
 * (zip.ts), firma WS-Security del sobre SOAP (wsSecuritySoap.ts) y envío
 * por mTLS (sendToDian.ts / sendInvoiceToDian.ts). Formato de transporte
 * confirmado en vivo contra el ambiente real de habilitación: SOAP plano
 * (`application/soap+xml`, ZIP en base64 inline), NO MTOM -- esa variante
 * dio 415. Sin Basic Auth -- no dio 401, no parece hacer falta.
 *
 * Tres acciones, tres modelos de autorización distintos:
 * - `send_test_invoice`: documento sintético, solo para probar
 *   config/certificado -- interno, mismo patrón que whatsapp-ai-respond,
 *   solo acepta SUPABASE_SERVICE_ROLE_KEY (o DIAN_SUBMIT_TEST_TOKEN, ver
 *   abajo).
 * - `send_invoice`/`retry_invoice`: factura REAL ya reservada por el
 *   trigger de confirmación -- la llama el propio tenant desde la app,
 *   mismo patrón que whatsapp-send-human (JWT del caller, no admin, RLS de
 *   sales_invoices hace el aislamiento por tenant), pero además restringido
 *   a tenant_admin/superadmin -- es una acción ad-hoc de reenvío/reintento
 *   con efecto fiscal real, no algo que un tenant_agent deba poder disparar
 *   libremente sobre cualquier factura.
 * - `send_pos_invoice` (2026-09-08): mismo pipeline de envío
 *   (sendInvoiceToDian), pero deliberadamente MÁS angosto que send_invoice
 *   -- no es "reenviar cualquier factura", es "el propio cajero, en el
 *   mismo instante de cobrar una venta de mostrador, pide que ESA venta se
 *   facture". Autorizado con has_permission('pos.checkout') (mismo permiso
 *   que ya gatea el botón "Cobrar" del POS) en vez de tenant_admin -- quien
 *   está habilitado para cobrar está habilitado para decidir si esa venta
 *   puntual se factura. Restringido a pedidos sales_channel='pos' ya
 *   confirmados, nunca crea una factura (solo envía la que el trigger ya
 *   reservó), y es idempotente ante un reintento de red sobre una que ya
 *   quedó sent/accepted. */

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

  let body: { tenant_id?: string; invoice_id?: string; order_id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (body.action === "send_invoice" || body.action === "retry_invoice") {
    return await handleSendInvoice(req, body, body.action === "retry_invoice");
  }

  if (body.action === "send_pos_invoice") {
    return await handleSendPosInvoice(req, body);
  }

  return await handleSendTestInvoice(req, body);
});

async function handleSendTestInvoice(req: Request, body: { tenant_id?: string; action?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Bypass de DIAN_SUBMIT_TEST_TOKEN retirado (auditoría de seguridad
  // 2026-09-04) -- era un secreto sin caducidad, sin caller real que lo
  // necesitara. Probar manualmente por curl ahora se hace con el service
  // role key real, igual que cualquier otro endpoint interno del proyecto.
  const authorized = authHeader === `Bearer ${serviceRoleKey}`;
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

/** Ver el bloque de comentario de cabecera para el porqué de esta acción
 * aparte de send_invoice/retry_invoice. Nunca crea una fila de
 * sales_invoices -- solo envía la que el trigger de confirmación ya
 * reservó, y solo si el pedido es del POS y ya está pago del todo. */
async function handleSendPosInvoice(req: Request, body: { order_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.order_id) return jsonResponse({ error: "expected_order_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return jsonResponse({ error: "Invalid session" }, 401);

  // Mismo permiso que ya gatea "Cobrar" en el POS -- tenant_admin/superadmin
  // pasan sin restricción, un tenant_agent necesita el grant explícito.
  const { data: allowed } = await callerClient.rpc("has_permission", { p_action_key: "pos.checkout" });
  if (!allowed) return jsonResponse({ error: "No tenés permiso para facturar desde el POS." }, 403);

  // RLS ya aísla por tenant -- si el pedido es de otro tenant, esto viene
  // null, igual que "no existe".
  const { data: order } = await callerClient.from("sales_orders").select("id, tenant_id, status, sales_channel").eq("id", body.order_id).maybeSingle();
  if (!order) return jsonResponse({ error: "Pedido no encontrado." }, 404);
  if (order.sales_channel !== "pos") return jsonResponse({ error: "Esta acción solo aplica a ventas del POS." }, 400);
  if (order.status !== "confirmada") return jsonResponse({ error: "El pedido todavía no está confirmado." }, 409);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Mismo candado real que handleSendInvoice -- no se transmite un
  // documento fiscal de una venta que todavía no está cobrada del todo.
  const { data: orderRow } = await adminClient.from("sales_orders").select("total, currency").eq("id", order.id).maybeSingle();
  const { data: payments } = await adminClient.from("sales_order_payments").select("amount").eq("order_id", order.id).is("deleted_at", null);
  const totalPaid = (payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  const balance = Math.max(0, (orderRow?.total ?? 0) - totalPaid);
  if (balance > 0) {
    const formatted = new Intl.NumberFormat("es-CO", { style: "currency", currency: orderRow?.currency ?? "COP", maximumFractionDigits: 0 }).format(balance);
    return jsonResponse({ error: `No se puede facturar mientras el pedido tenga saldo pendiente (${formatted}).` }, 409);
  }

  // La factura ya la reservó el trigger de confirmación -- acá solo se
  // busca el intento vigente (attempt_number más alto), nunca se crea uno.
  const { data: invoice } = await adminClient
    .from("sales_invoices")
    .select("id, status, cufe, dian_tracking_id, invoice_prefix, invoice_number")
    .eq("order_id", order.id)
    .eq("tenant_id", order.tenant_id)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!invoice) return jsonResponse({ error: "Este pedido no tiene una factura DIAN reservada." }, 404);
  if (invoice.status === "blocked_missing_buyer_data") {
    return jsonResponse({ error: "Faltan datos fiscales del comprador elegido para esta factura." }, 409);
  }
  // Idempotencia: un reintento de red que ya había llegado a buen puerto no
  // debe reenviar -- devuelve el resultado ya final en vez de fallar o
  // duplicar el envío.
  if (invoice.status === "sent" || invoice.status === "accepted") {
    return jsonResponse({
      status: "sent",
      httpStatus: 200,
      cufe: invoice.cufe,
      dianTrackingId: invoice.dian_tracking_id,
      faultReason: null,
      invoicePrefix: invoice.invoice_prefix ?? "",
      invoiceNumber: invoice.invoice_number ?? 0,
    });
  }
  if (invoice.status !== "pending") {
    return jsonResponse({ error: `Esta factura está en estado "${invoice.status}", no se puede enviar.` }, 409);
  }

  try {
    const result = await sendInvoiceToDian(adminClient, order.tenant_id, invoice.id);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
