/** Genera la representación gráfica (PDF) de una nota crédito ya enviada a
 * la DIAN -- mismo motivo que sales-invoice-pdf: el CUDE solo no le sirve a
 * nadie, pedido explícito del usuario ("y como descargo o visualizo la
 * nota crédito?", 2026-09-09) apenas después de poder emitirlas.
 *
 * El armado del PDF vive en `_shared/invoicing/renderCreditNotePdf.ts`
 * porque la entrega por correo al adquiriente necesita EXACTAMENTE el mismo
 * documento (ver el comentario de cabecera de ese archivo). Acá queda solo
 * la autorización -- mismo reparto que sales-invoice-pdf. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { CreditNoteNotPrintableError, renderCreditNotePdf } from "../_shared/invoicing/renderCreditNotePdf.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { credit_note_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.credit_note_id) return json({ error: "credit_note_id es requerido." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  // La autorización se resuelve con el cliente del CALLER, no con el admin:
  // la RLS de sales_credit_notes ya aísla por tenant, así que una nota de
  // otro tenant viene null, igual que "no existe". Recién después se arma
  // el PDF con el admin client (necesita leer tenants/integraciones).
  const { data: allowed } = await callerClient.from("sales_credit_notes").select("id").eq("id", body.credit_note_id).maybeSingle();
  if (!allowed) return json({ error: "Nota crédito no encontrada." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  try {
    const { bytes, filename } = await renderCreditNotePdf(adminClient, body.credit_note_id);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return json({ pdf_base64: btoa(binary), filename });
  } catch (err) {
    if (err instanceof CreditNoteNotPrintableError) return json({ error: err.message }, 409);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
