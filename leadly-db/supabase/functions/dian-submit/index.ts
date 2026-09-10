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
import { sendCreditNoteToDian } from "../_shared/invoicing/sendCreditNoteToDian.ts";
import { createInvoiceAttempt } from "../_shared/invoicing/queueInvoiceGeneration.ts";
import { getTenantNumberingRangeFromDian } from "../_shared/invoicing/getNumberingRange.ts";
import { loadTenantCertificate } from "../_shared/invoicing/dianClient.ts";
import { buildInvoiceXml } from "../_shared/invoicing/buildInvoiceXml.ts";
import { signInvoiceXml } from "../_shared/invoicing/signInvoiceXml.ts";
import { queryDianTrackStatus, type DianStatusOperation } from "../_shared/invoicing/getDianStatus.ts";
import { interpretDianStatus, applyInvoiceVerdict, applyCreditNoteVerdict } from "../_shared/invoicing/applyDianVerdict.ts";
import { corsHeaders } from "../_shared/cors.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  // Mismo bug de CORS que calculate-order -- el botón "Enviar a la DIAN"
  // del portal llama esto directo desde el navegador, que exige el
  // preflight OPTIONS. Corregido en el mismo momento (2026-09-03).
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: {
    tenant_id?: string;
    invoice_id?: string;
    order_id?: string;
    action?: string;
    amount?: number;
    reason_code?: string;
    reason_description?: string;
    credit_note_id?: string;
    track_id?: string;
  };
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

  if (body.action === "create_credit_note") {
    return await handleCreateCreditNote(req, body);
  }

  if (body.action === "retry_credit_note") {
    return await handleRetryCreditNote(req, body);
  }

  if (body.action === "sync_dian_numbering_range") {
    return await handleSyncNumberingRange(req, body);
  }

  if (body.action === "check_invoice_status") {
    return await handleCheckInvoiceStatus(req, body);
  }

  if (body.action === "lookup_dian_document") {
    return await handleLookupDianDocument(req, body);
  }

  if (body.action === "check_credit_note_status") {
    return await handleCheckCreditNoteStatus(req, body);
  }

  if (body.action === "check_certificate") {
    return await handleCheckCertificate(req, body);
  }

  if (body.action === "debug_verify_signature") {
    return await handleDebugVerifySignature(req, body);
  }

  if (body.action === "debug_dump_invoice_xml") {
    return await handleDebugDumpInvoiceXml(req, body);
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
    .select("id, tenant_id, order_id, status, attempt_number, total")
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
  // 20260903110000_sales_invoices.sql). El trigger
  // guard_sales_invoice_live_attempt (que reemplazó al índice único parcial
  // que había acá antes) es el candado real del lado de la DB; esto solo
  // adelanta la misma validación para dar un mensaje claro en vez de dejar
  // que reviente como excepción de trigger. Dos casos legítimos de
  // "reintento": la factura anterior fracasó (rejected/error), o la
  // vigente ya está sent/accepted pero quedó totalmente acreditada por
  // nota crédito -- volver a facturar el pedido después de corregirlo, no
  // hay ningún flujo de "anular" en este esquema (ver la migración
  // 20260909220000_sales_invoices_no_voided_reissue_after_credit.sql).
  let invoiceIdToSend = body.invoice_id;
  if (isRetry) {
    const canRetryFailed = invoiceRow.status === "rejected" || invoiceRow.status === "error";
    let canReissueAfterCredit = false;
    if (!canRetryFailed && (invoiceRow.status === "sent" || invoiceRow.status === "accepted")) {
      const { data: creditNotes } = await adminClient
        .from("sales_credit_notes")
        .select("total")
        .eq("invoice_id", invoiceRow.id)
        .in("status", ["sent", "accepted"]);
      const credited = (creditNotes ?? []).reduce((sum, cn) => sum + Number(cn.total), 0);
      canReissueAfterCredit = credited + 0.01 >= Number(invoiceRow.total ?? 0);
    }
    if (!canRetryFailed && !canReissueAfterCredit) {
      return jsonResponse(
        {
          error:
            `Esta factura está en estado "${invoiceRow.status}"; sólo se puede reintentar una rechazada por la DIAN, ` +
            `con error de envío, o emitir una nueva si la vigente ya fue acreditada por completo con una nota crédito.`,
        },
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

/** Crea (create_credit_note_attempt, ver la migración) y manda de una sola
 * vez una nota crédito sobre una factura ya aceptada por la DIAN. Mismo
 * modelo de autorización que send_invoice/retry_invoice -- acción con
 * efecto fiscal real, restringida a tenant_admin/superadmin, nunca a un
 * tenant_agent. Toda la validación de negocio (factura aceptada, saldo
 * disponible, tarifa de impuesto única) vive en la función de Postgres,
 * que corre en una sola transacción -- acá solo se resuelve el caller y se
 * pasa el resultado. */
async function handleCreateCreditNote(
  req: Request,
  body: { invoice_id?: string; amount?: number; reason_code?: string; reason_description?: string },
): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.invoice_id) return jsonResponse({ error: "expected_invoice_id" }, 400);
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount <= 0) {
    return jsonResponse({ error: "expected_positive_amount" }, 400);
  }
  if (!body.reason_code || !body.reason_description) {
    return jsonResponse({ error: "expected_reason_code_and_description" }, 400);
  }

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
    return jsonResponse({ error: "Solo un administrador del tenant puede emitir notas crédito." }, 403);
  }

  // RLS de sales_invoices ya aísla por tenant -- si la factura es de otro
  // tenant, esto viene null, igual que "no existe". No se usa
  // profile.tenant_id para esto: un superadmin (que puede emitir en
  // nombre de cualquier tenant) tiene esa columna en null.
  const { data: invoiceRow } = await callerClient.from("sales_invoices").select("tenant_id").eq("id", body.invoice_id).maybeSingle();
  if (!invoiceRow) return jsonResponse({ error: "Factura no encontrada." }, 404);

  // create_credit_note_attempt vuelve a validar tenant/rol/estado de la
  // factura del lado de la DB (defensa en profundidad) -- se llama con el
  // client del propio caller, no el admin, para que corra bajo su sesión
  // real (auth.uid()/auth_active_tenant_id() dentro de la función).
  const { data: newCreditNoteId, error: createError } = await callerClient.rpc("create_credit_note_attempt", {
    p_invoice_id: body.invoice_id,
    p_amount: body.amount,
    p_reason_code: body.reason_code,
    p_reason_description: body.reason_description,
  });
  if (createError) return jsonResponse({ error: createError.message }, 409);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await sendCreditNoteToDian(adminClient, invoiceRow.tenant_id, newCreditNoteId as string);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Reintenta una nota crédito que quedó en 'error' o fue 'rejected' por la
 * DIAN -- misma fila, mismos datos (monto/motivo ya validados al crearla),
 * solo se vuelve a intentar el envío. No pasa por
 * create_credit_note_attempt de nuevo (no hay nada nuevo que validar: la
 * fila ya existe con su desglose de impuesto calculado). Mismo modelo de
 * autorización que el resto de acciones con efecto fiscal real. */
async function handleRetryCreditNote(req: Request, body: { credit_note_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.credit_note_id) return jsonResponse({ error: "expected_credit_note_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return jsonResponse({ error: "Invalid session" }, 401);

  const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).maybeSingle();
  if (!profile || (profile.role !== "tenant_admin" && profile.role !== "superadmin")) {
    return jsonResponse({ error: "Solo un administrador del tenant puede reintentar una nota crédito." }, 403);
  }

  // RLS de sales_credit_notes ya aísla por tenant -- si es de otro tenant,
  // esto viene null, igual que "no existe".
  const { data: creditNoteRow } = await callerClient.from("sales_credit_notes").select("tenant_id, status").eq("id", body.credit_note_id).maybeSingle();
  if (!creditNoteRow) return jsonResponse({ error: "Nota crédito no encontrada." }, 404);
  if (creditNoteRow.status !== "error" && creditNoteRow.status !== "rejected") {
    return jsonResponse({ error: `Esta nota crédito está en estado "${creditNoteRow.status}", no se puede reintentar.` }, 409);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await sendCreditNoteToDian(adminClient, creditNoteRow.tenant_id, body.credit_note_id);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Botón "Sincronizar con la DIAN" en Integraciones -- pedido explícito del
 * usuario 2026-09-09: en vez de tipear a mano prefijo/rango/vigencia cada
 * vez que cambia la resolución, consultarla directo de la DIAN
 * (GetNumberingRangeAsync, ver getNumberingRange.ts) usando el certificado
 * ya cargado. Deliberadamente manual (un botón, no un cron) -- decisión
 * explícita del usuario por ahora. Solo LEE de la DIAN -- no escribe nada
 * en tenant_dian_profile; el frontend precarga el formulario con el
 * resultado y el usuario sigue teniendo que apretar "Guardar cambios" como
 * con cualquier otro campo, para no pisar una configuración que funciona
 * con un parseo todavía no verificado en vivo (ver el comentario de
 * cabecera de getNumberingRange.ts). Tampoco toca `next_invoice_number` --
 * saber "qué resolución está vigente" y saber "en qué consecutivo real voy"
 * son dos preguntas distintas, la segunda sigue siendo una decisión manual. */
async function handleSyncNumberingRange(req: Request, body: { tenant_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.tenant_id) return jsonResponse({ error: "expected_tenant_id" }, 400);

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
  const isSuperadmin = profile?.role === "superadmin";
  const isOwnTenantAdmin = profile?.role === "tenant_admin" && profile.tenant_id === body.tenant_id;
  if (!isSuperadmin && !isOwnTenantAdmin) {
    return jsonResponse({ error: "Solo un administrador del tenant puede sincronizar la resolución DIAN." }, 403);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await getTenantNumberingRangeFromDian(adminClient, body.tenant_id);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Diagnóstico puntual 2026-09-10, contra el rechazo real ZE02 ("Valida
 * firma del documento") -- una causa frecuente y documentada de ese error
 * en otros facturadores es un certificado vencido o cuyo período de
 * vigencia no cubre la fecha real de la firma. Solo descarga/desencripta el
 * .p12 ya guardado y devuelve su vigencia -- NUNCA firma ni manda nada a la
 * DIAN, así que no consume ningún consecutivo ni intento del test set de
 * habilitación. Mismo modelo de autorización que check_invoice_status
 * (tenant_admin/superadmin del propio tenant vía RLS). */
async function handleCheckCertificate(req: Request, body: { tenant_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.tenant_id) return jsonResponse({ error: "expected_tenant_id" }, 400);

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
  const isSuperadmin = profile?.role === "superadmin";
  const isOwnTenantAdmin = profile?.role === "tenant_admin" && profile.tenant_id === body.tenant_id;
  if (!isSuperadmin && !isOwnTenantAdmin) {
    return jsonResponse({ error: "Solo un administrador del tenant puede revisar su certificado DIAN." }, 403);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const cert = await loadTenantCertificate(adminClient, body.tenant_id);
    const now = new Date();

    // deno-lint-ignore no-explicit-any
    const forge = (await import("npm:node-forge@1")).default as any;
    let certBinary = "";
    const certBytes = new Uint8Array(cert.certificateDer);
    for (let i = 0; i < certBytes.length; i++) certBinary += String.fromCharCode(certBytes[i]);
    const parsedCert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(certBinary));
    const issuerAttrs = parsedCert.issuer.attributes.map((a: { shortName?: string; name?: string; value: string }) => `${a.shortName ?? a.name}=${a.value}`).join(", ");
    const subjectAttrs = parsedCert.subject.attributes.map((a: { shortName?: string; name?: string; value: string }) => `${a.shortName ?? a.name}=${a.value}`).join(", ");
    const isSelfSigned = issuerAttrs === subjectAttrs;

    return jsonResponse({
      subjectCommonName: cert.subjectCommonName,
      validFrom: cert.validFrom.toISOString(),
      validTo: cert.validTo.toISOString(),
      isCurrentlyValid: now >= cert.validFrom && now <= cert.validTo,
      now: now.toISOString(),
      issuer: issuerAttrs,
      subject: subjectAttrs,
      isSelfSigned,
      serialNumber: parsedCert.serialNumber,
      extensions: parsedCert.extensions.map((e: { name?: string; id?: string }) => e.name ?? e.id),
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Diagnóstico 2026-09-10: devuelve el XML firmado EXACTO de una factura ya
 * existente (mismo pipeline real de sendInvoiceToDian, con el certificado
 * real del tenant) SIN mandarlo a la DIAN ni tocar la base -- hacía falta
 * para poder comparar byte a byte lo que generamos contra una factura real
 * ya aceptada, sin quemar otro consecutivo del test set de habilitación
 * (van 9 rechazos idénticos por ZE02 con todo lo verificable ya verificado). */
async function handleDebugDumpInvoiceXml(req: Request, body: { invoice_id?: string }): Promise<Response> {
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

  const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).maybeSingle();
  if (!profile || (profile.role !== "tenant_admin" && profile.role !== "superadmin")) {
    return jsonResponse({ error: "Solo un administrador del tenant puede ejecutar este diagnóstico." }, 403);
  }

  // RLS aísla por tenant -- si la factura es de otro tenant, viene null.
  const { data: invoiceRow } = await callerClient.from("sales_invoices").select("tenant_id").eq("id", body.invoice_id).maybeSingle();
  if (!invoiceRow) return jsonResponse({ error: "Factura no encontrada." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await sendInvoiceToDian(adminClient, invoiceRow.tenant_id, body.invoice_id, { dryRun: true });
    return jsonResponse({ cufe: result.cufe, invoicePrefix: result.invoicePrefix, invoiceNumber: result.invoiceNumber, signedXml: result.signedXml });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Diagnóstico puntual 2026-09-10, contra el rechazo ZE02 persistente
 * después de corregir dos causas estructurales distintas (referencia
 * faltante a KeyInfo, canonicalización de SignedInfo) sin que ninguna
 * cambiara el resultado real -- hipótesis más fundamental sin probar
 * todavía: ¿la clave privada real de este tenant corresponde de verdad a
 * la clave pública de SU PROPIO certificado? Si no corresponden (archivo
 * .p12 equivocado, o parsePkcs12 extrayendo la clave de un bag distinto al
 * certificado en un contenedor con más de un par), ninguna corrección de
 * canonicalización iba a funcionar jamás. Firma un XML sintético con el
 * certificado/clave REALES del tenant y lo verifica con la clave pública
 * extraída de ESE MISMO certificado -- NUNCA manda nada a la DIAN, no
 * consume ningún intento del test set de habilitación. */
async function handleDebugVerifySignature(req: Request, body: { tenant_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.tenant_id) return jsonResponse({ error: "expected_tenant_id" }, 400);

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
  const isSuperadmin = profile?.role === "superadmin";
  const isOwnTenantAdmin = profile?.role === "tenant_admin" && profile.tenant_id === body.tenant_id;
  if (!isSuperadmin && !isOwnTenantAdmin) {
    return jsonResponse({ error: "Solo un administrador del tenant puede ejecutar este diagnóstico." }, 403);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const cert = await loadTenantCertificate(adminClient, body.tenant_id);

    // deno-lint-ignore no-explicit-any
    const forge = (await import("npm:node-forge@1")).default as any;
    let certBinary = "";
    const certBytes = new Uint8Array(cert.certificateDer);
    for (let i = 0; i < certBytes.length; i++) certBinary += String.fromCharCode(certBytes[i]);
    const parsedCert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(certBinary));
    const publicKeySpkiDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(parsedCert.publicKey)).getBytes();
    const publicKeyBytes = new Uint8Array(publicKeySpkiDer.length);
    for (let i = 0; i < publicKeySpkiDer.length; i++) publicKeyBytes[i] = publicKeySpkiDer.charCodeAt(i);
    const publicKey = await crypto.subtle.importKey("spki", publicKeyBytes.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);

    const { xml: unsignedXml } = await buildInvoiceXml({
      invoiceId: "DEBUG000000001",
      issueDate: "2026-01-01",
      issueTime: "12:00:00-05:00",
      currency: "COP",
      environment: 2,
      seller: { legalName: "DEBUG", documentTypeCode: "31", documentNumber: "900000000", addressLine: null, city: null, stateProvince: null, countryCode: "CO", taxLevelCode: "R-99-PN" },
      buyer: { legalName: "DEBUG", documentTypeCode: "13", documentNumber: "1000000000", addressLine: null, city: null, stateProvince: null, countryCode: "CO", taxLevelCode: "R-99-PN" },
      lines: [{ id: 1, description: "DEBUG", quantity: 1, unitPrice: 100, lineExtensionAmount: 100, tax: null }],
      withholdings: [],
      resolution: { number: "DEBUG", prefix: "DEBUG", rangeFrom: "1", rangeTo: "2", validFrom: "2026-01-01", validUntil: "2027-01-01" },
      softwareId: "00000000-0000-0000-0000-000000000000",
      softwarePin: "0000",
      technicalKey: "debug",
      authorizationProviderNit: "800197268",
      payment: { meansId: "1", meansCode: "10" },
    });
    const signedXml = await signInvoiceXml({ unsignedXml, privateKey: cert.privateKey, certificateDer: cert.certificateDer });

    const { DOMParser } = await import("npm:@xmldom/xmldom@0.8");
    const xmldsig = await import("npm:xmldsigjs@2");
    // deno-lint-ignore no-explicit-any
    (xmldsig as any).Application.setEngine("Deno", crypto);
    const doc = new (DOMParser as any)().parseFromString(signedXml, "text/xml");
    const signedInfoEl = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "SignedInfo")[0];
    const signatureValueEl = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "SignatureValue")[0];
    const sigB64 = signatureValueEl.textContent.trim();
    const sigBinary = atob(sigB64);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) sigBytes[i] = sigBinary.charCodeAt(i);

    // deno-lint-ignore no-explicit-any
    const canonicalizer = new (xmldsig as any).XmlCanonicalizer(false, false);
    const canonicalSignedInfo = canonicalizer.Canonicalize(signedInfoEl);
    const canonicalBytes = typeof canonicalSignedInfo === "string" ? new TextEncoder().encode(canonicalSignedInfo) : canonicalSignedInfo;

    const verified = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, sigBytes, canonicalBytes);

    return jsonResponse({
      certificateSubject: cert.subjectCommonName,
      certParsedSubjectCN: parsedCert.subject?.getField("CN")?.value ?? null,
      signatureVerifiesAgainstOwnCertificate: verified,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 500);
  }
}

/** Botón "Verificar estado" -- respaldo MANUAL para cuando el polling
 * síncrono de sendInvoiceToDian.ts (ver ese archivo, pedido explícito del
 * usuario 2026-09-09: "el endpoint debe verificar el estado y devolverme
 * si hubo error o no") se agotó sin una respuesta concluyente de la DIAN
 * -- ya no es el paso obligatorio para saber si una factura se aceptó o
 * rechazó, pero sigue haciendo falta para ese caso puntual (procesamiento
 * más lento de lo que esa función puede esperar). Reusa
 * interpretDianStatus/applyInvoiceVerdict (applyDianVerdict.ts) -- mismo
 * código exacto que usa el camino síncrono, así que si esto resuelve a
 * "accepted" también avanza next_invoice_number acá, no solo en el envío. */
/** `dian_tracking_id` guarda dos cosas distintas según cómo se envió el
 * documento, y cada una se consulta con una operación distinta (ver
 * getDianStatus.ts): el `zipKey` de un envío asíncrono (habilitación,
 * `SendTestSetAsync`) va con `GetStatusZip`, mientras que en producción
 * (`SendBillSync`) no hay zipKey y lo guardado es el CUFE, que va con
 * `GetStatus`. Se distinguen comparando contra el CUFE de la propia fila
 * en vez de adivinar por formato -- los dos son cadenas hex largas. */
function statusOperationFor(trackingId: string, cufe: string | null): DianStatusOperation {
  return cufe && trackingId === cufe ? "GetStatus" : "GetStatusZip";
}

async function handleCheckInvoiceStatus(req: Request, body: { invoice_id?: string }): Promise<Response> {
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

  const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).maybeSingle();
  if (!profile || (profile.role !== "tenant_admin" && profile.role !== "superadmin")) {
    return jsonResponse({ error: "Solo un administrador del tenant puede verificar el estado de una factura." }, 403);
  }

  // RLS de sales_invoices ya aísla por tenant -- si es de otro tenant, esto
  // viene null, igual que "no existe".
  const { data: invoiceRow } = await callerClient.from("sales_invoices").select("tenant_id, status, dian_tracking_id, invoice_number, cufe").eq("id", body.invoice_id).maybeSingle();
  if (!invoiceRow) return jsonResponse({ error: "Factura no encontrada." }, 404);
  if (invoiceRow.status !== "sent") {
    return jsonResponse({ error: `Esta factura está en estado "${invoiceRow.status}" -- solo tiene sentido verificar una que quedó "enviada" sin confirmar todavía.` }, 409);
  }
  if (!invoiceRow.dian_tracking_id) {
    return jsonResponse({ error: "Esta factura no tiene un identificador de seguimiento de la DIAN guardado." }, 409);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await queryDianTrackStatus(
      adminClient,
      invoiceRow.tenant_id,
      invoiceRow.dian_tracking_id,
      undefined,
      statusOperationFor(invoiceRow.dian_tracking_id, invoiceRow.cufe),
    );
    if (!result.faultReason) {
      const verdict = interpretDianStatus(result.statuses[0] ?? null);
      await applyInvoiceVerdict(adminClient, invoiceRow.tenant_id, body.invoice_id, Number(invoiceRow.invoice_number ?? 0), verdict);
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Consulta de SOLO LECTURA del estado real de una factura en la DIAN, sin
 * importar en qué estado la tenga la base y sin escribir nada.
 *
 * Distinta de `check_invoice_status`, que existe para resolver una factura
 * que quedó colgada en `sent` y por eso exige ese estado y aplica el
 * veredicto sobre la fila. Esta es para responder "¿la DIAN de verdad tiene
 * este documento?" -- típicamente cuando la factura figura aceptada acá
 * pero el usuario no la encuentra en el portal. Pregunta y devuelve lo que
 * la DIAN conteste, tal cual, sin tocar `sales_invoices`: si hubiera una
 * discrepancia real entre lo que dice la DIAN y lo guardado, hay que verla
 * antes de que algo la sobrescriba. */
async function handleLookupDianDocument(req: Request, body: { invoice_id?: string; track_id?: string; tenant_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

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
    return jsonResponse({ error: "Solo un administrador del tenant puede consultar el estado de un documento en la DIAN." }, 403);
  }

  let tenantId: string | null = null;
  let trackId: string | null = null;
  let cufe: string | null = null;
  let stored: Record<string, unknown> | null = null;

  if (body.invoice_id) {
    // RLS de sales_invoices aísla por tenant -- una factura ajena vuelve
    // null, igual que una inexistente.
    const { data: row } = await callerClient
      .from("sales_invoices")
      .select("tenant_id, status, status_detail, invoice_prefix, invoice_number, cufe, dian_tracking_id, sent_at")
      .eq("id", body.invoice_id)
      .maybeSingle();
    if (!row) return jsonResponse({ error: "Factura no encontrada." }, 404);
    tenantId = row.tenant_id;
    cufe = row.cufe;
    trackId = row.dian_tracking_id ?? row.cufe;
    stored = row;
  } else if (body.track_id) {
    // Consulta suelta por CUFE/trackId, para un documento que ni siquiera
    // tenga fila acá. Un superadmin debe decir de qué tenant sale el
    // certificado; un tenant_admin solo puede usar el suyo.
    tenantId = profile.role === "superadmin" ? (body.tenant_id ?? null) : profile.tenant_id;
    trackId = body.track_id;
    cufe = body.track_id;
    if (!tenantId) return jsonResponse({ error: "expected_tenant_id" }, 400);
  } else {
    return jsonResponse({ error: "expected_invoice_id_or_track_id" }, 400);
  }

  if (!trackId) {
    return jsonResponse({ error: "Esta factura no tiene CUFE ni identificador de seguimiento guardado -- nunca llegó a enviarse." }, 409);
  }
  if (!tenantId) return jsonResponse({ error: "expected_tenant_id" }, 400);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const operation = statusOperationFor(trackId, cufe);
    const result = await queryDianTrackStatus(adminClient, tenantId, trackId, undefined, operation);
    return jsonResponse({ operation, trackId, stored, dian: result });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** Misma idea que handleCheckInvoiceStatus, para una nota crédito. */
async function handleCheckCreditNoteStatus(req: Request, body: { credit_note_id?: string }): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  if (!body.credit_note_id) return jsonResponse({ error: "expected_credit_note_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return jsonResponse({ error: "Invalid session" }, 401);

  const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).maybeSingle();
  if (!profile || (profile.role !== "tenant_admin" && profile.role !== "superadmin")) {
    return jsonResponse({ error: "Solo un administrador del tenant puede verificar el estado de una nota crédito." }, 403);
  }

  const { data: creditNoteRow } = await callerClient
    .from("sales_credit_notes")
    .select("tenant_id, status, dian_tracking_id, credit_note_number, cude")
    .eq("id", body.credit_note_id)
    .maybeSingle();
  if (!creditNoteRow) return jsonResponse({ error: "Nota crédito no encontrada." }, 404);
  if (creditNoteRow.status !== "sent") {
    return jsonResponse({ error: `Esta nota crédito está en estado "${creditNoteRow.status}" -- solo tiene sentido verificar una que quedó "enviada" sin confirmar todavía.` }, 409);
  }
  if (!creditNoteRow.dian_tracking_id) {
    return jsonResponse({ error: "Esta nota crédito no tiene un identificador de seguimiento de la DIAN guardado." }, 409);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const result = await queryDianTrackStatus(
      adminClient,
      creditNoteRow.tenant_id,
      creditNoteRow.dian_tracking_id,
      undefined,
      statusOperationFor(creditNoteRow.dian_tracking_id, creditNoteRow.cude ?? null),
    );
    if (!result.faultReason) {
      const verdict = interpretDianStatus(result.statuses[0] ?? null);
      await applyCreditNoteVerdict(adminClient, creditNoteRow.tenant_id, body.credit_note_id, Number(creditNoteRow.credit_note_number ?? 0), verdict);
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
