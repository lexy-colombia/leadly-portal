/** Entrega del documento electrónico al adquiriente por correo (Anexo
 * Técnico DIAN, numeral 9.3). Function propia y liviana a propósito.
 *
 * ⚠️ Por qué NO vive dentro de dian-submit, que sería lo obvio: son dos
 * pilas de dependencias incompatibles en el runtime real de Edge
 * Functions. dian-submit tiene que importar `nodeCompatShim.ts` como su
 * primerísima línea para reemplazar el polyfill de `process` por un objeto
 * mínimo, sin el cual pkijs/node-forge (la pila de firma XML) revientan al
 * importarse. Pero pdf-lib -- que hace falta para adjuntar la
 * representación gráfica -- llama a `process.nextTick`, que ese objeto
 * mínimo no tiene. Encontrado en vivo el 2026-09-10 al probar el botón:
 * `process.nextTick is not a function`, registrado tal cual en
 * sales_document_emails.
 *
 * Se podría haber parcheado el shim agregándole un `nextTick`, pero
 * separar es mejor por dos razones que van más allá del bug: (1) mantiene
 * pdf-lib fuera de la función que firma y transmite documentos fiscales,
 * que ya tuvo un "CPU Time exceeded" real por acumular trabajo pesado en
 * una sola invocación (ver getDianStatus.ts); (2) el envío de correo no
 * comparte NADA con la firma -- juntarlos solo sumaba superficie.
 *
 * Dos modos de autorización sobre el mismo endpoint:
 * - Service role: la llama `applyDianVerdict.ts` cuando la DIAN acepta un
 *   documento (envío automático). Mismo patrón interno que
 *   whatsapp-ai-respond.
 * - JWT de usuario: el botón "Enviar por correo" del portal, restringido a
 *   tenant_admin/superadmin -- es una comunicación saliente a un tercero a
 *   nombre del comercio, no algo que cualquier agente deba disparar en
 *   bucle. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { sendDocumentEmail } from "../_shared/invoicing/sendDocumentEmail.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { invoice_id?: string; credit_note_id?: string; tenant_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.invoice_id && !body.credit_note_id) return json({ error: "expected_invoice_id_or_credit_note_id" }, 400);
  if (body.invoice_id && body.credit_note_id) return json({ error: "expected_only_one_document" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const isInvoice = Boolean(body.invoice_id);
  const table: "sales_invoices" | "sales_credit_notes" = isInvoice ? "sales_invoices" : "sales_credit_notes";
  const documentId = (body.invoice_id ?? body.credit_note_id)!;

  // Comparación por string, no decodificando como JWT: el service role key
  // puede venir en formato JWT clásico o `sb_secret_...` (pitfall ya
  // documentado en CLAUDE.md).
  const isInternal = authHeader === `Bearer ${serviceRoleKey}`;

  let tenantId: string;
  let actorId: string | null = null;
  let triggeredBy: "auto" | "manual";

  if (isInternal) {
    triggeredBy = "auto";
    const { data: row } = await adminClient.from(table).select("tenant_id").eq("id", documentId).maybeSingle();
    if (!row) return json({ error: "Documento no encontrado." }, 404);
    tenantId = row.tenant_id;
  } else {
    triggeredBy = "manual";
    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const {
      data: { user: caller },
      error: callerError,
    } = await callerClient.auth.getUser();
    if (callerError || !caller) return json({ error: "Invalid session" }, 401);

    const { data: profile } = await callerClient.from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!profile || (profile.role !== "tenant_admin" && profile.role !== "superadmin")) {
      return json({ error: "Solo un administrador del tenant puede enviar un documento electrónico." }, 403);
    }

    // RLS aísla por tenant -- un documento ajeno vuelve null, igual que uno
    // inexistente. Este chequeo con el JWT del caller ES la autorización.
    const { data: row } = await callerClient.from(table).select("tenant_id, status").eq("id", documentId).maybeSingle();
    if (!row) return json({ error: "Documento no encontrado." }, 404);
    if (row.status !== "accepted" && row.status !== "sent") {
      return json({ error: `Este documento está en estado "${row.status}" -- solo se le entrega al cliente un documento que la DIAN ya recibió.` }, 409);
    }
    tenantId = row.tenant_id;
    actorId = caller.id;
  }

  const result = await sendDocumentEmail(
    adminClient,
    tenantId,
    { kind: isInvoice ? "invoice" : "credit_note", table, id: documentId },
    triggeredBy,
    actorId,
  );

  // `skipped` (el cliente no tiene correo) es un 409, no un 200 silencioso
  // ni un 500: es accionable por el usuario -- cárgale el correo al cliente
  // y vuelve a intentar. En el camino automático el caller lo ignora.
  if (result.outcome === "skipped") return json({ error: result.detail, outcome: result.outcome }, 409);
  if (result.outcome === "error") return json({ error: result.detail, outcome: result.outcome }, 502);
  return json(result);
});
