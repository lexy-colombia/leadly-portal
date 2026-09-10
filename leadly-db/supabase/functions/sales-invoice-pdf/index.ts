/** Genera la representación gráfica (PDF) de una factura DIAN y la devuelve
 * en base64 -- ver buildInvoicePdf.ts para el porqué del layout. Pedido
 * explícito del usuario 2026-09-03: el CUFE solo no le sirve a nadie, tiene
 * que poder descargar/ver un PDF real.
 *
 * A diferencia de dian-submit (que firma y envía, acción con efecto fiscal
 * real, admin-only), esto es solo lectura/render -- cualquier miembro del
 * tenant puede verlo, mismo criterio que ver el propio pedido. No usa
 * nodeCompatShim/pkijs/xmldsigjs (nada de firma acá), function liviana y
 * separada a propósito.
 *
 * Se genera on-demand en cada llamada -- no se cachea en Storage, ver
 * comentario de cabecera en buildInvoicePdf.ts.
 *
 * El armado del PDF vive en `_shared/invoicing/renderInvoicePdf.ts` desde
 * el 2026-09-10 (antes estaba todo acá): la entrega por correo al
 * adquiriente necesita exactamente el mismo documento, y tener dos copias
 * de la lógica que decide "esto es factura o es remisión" era garantía de
 * que se desincronizaran. Acá queda solo la autorización. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { renderInvoicePdfForOrder, bytesToBase64 } from "../_shared/invoicing/renderInvoicePdf.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.order_id) return json({ error: "order_id es requerido." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  // RLS de sales_orders ya aísla por tenant -- si el pedido es de otro
  // tenant, esto viene null, igual que "no existe". Este chequeo con el JWT
  // del caller ES la autorización: el render de abajo usa admin client, así
  // que no puede quedar afuera.
  const { data: order } = await callerClient.from("sales_orders").select("id").eq("id", body.order_id).maybeSingle();
  if (!order) return json({ error: "Pedido no encontrado." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const { bytes, filename } = await renderInvoicePdfForOrder(adminClient, body.order_id);
    return json({ pdf_base64: bytesToBase64(bytes), filename });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
