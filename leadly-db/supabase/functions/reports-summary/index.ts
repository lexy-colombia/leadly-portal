/** Edge Function del módulo "Reportes" (balance financiero + reportes de
 * producto) -- mismo patrón exacto que list-expenses/index.ts: JWT del
 * caller -> profiles.tenant_id -> admin client (service role) llama a la
 * RPC de agregación correspondiente. El tenant_id SIEMPRE sale del perfil
 * del caller autenticado, nunca de lo que mande el body.
 *
 * Body: { report: 'financial' | 'products', date_from: string, date_to:
 * string, limit?: number, stale_days?: number }.
 *
 * Convención de rango de fechas -- IMPORTANTE para quien consuma esto desde
 * el frontend: [date_from, date_to), igual que get_sales_orders_summary
 * (o.created_at < date_to). date_from/date_to son timestamps ISO; el
 * llamador es responsable de mandar date_to como el instante EXCLUSIVO de
 * cierre del rango (ej. medianoche del día siguiente al último día que se
 * quiere incluir), no el último día inclusive -- si no, el último día del
 * rango queda afuera.
 *
 * Sin chequeo de has_permission('reports.view') server-side -- mismo
 * criterio ya existente en list-expenses/list-sales-orders (enforcement de
 * permiso es solo de frontend hoy, deuda ya documentada y aceptada en el
 * hito 5 de Roles y Permisos, no se resuelve acá). */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

type ReportKind = "financial" | "products";

interface ReportsSummaryBody {
  report?: ReportKind;
  date_from?: string;
  date_to?: string;
  limit?: number;
  stale_days?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: ReportsSummaryBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.report !== "financial" && body.report !== "products") {
    return json({ error: "report debe ser 'financial' o 'products'." }, 400);
  }
  if (!body.date_from || !body.date_to) {
    return json({ error: "date_from y date_to son obligatorios." }, 400);
  }
  const dateFrom = new Date(body.date_from);
  const dateTo = new Date(body.date_to);
  if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime())) {
    return json({ error: "date_from/date_to deben ser fechas válidas." }, 400);
  }
  if (dateTo <= dateFrom) {
    return json({ error: "date_to debe ser posterior a date_from." }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  const { data: profile } = await callerClient.from("profiles").select("tenant_id").eq("id", caller.id).maybeSingle();
  if (!profile?.tenant_id) return json({ error: "No se pudo resolver el tenant del usuario." }, 403);
  const tenantId = profile.tenant_id as string;

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  if (body.report === "financial") {
    const { data, error } = await adminClient.rpc("get_reports_financial_summary", {
      p_tenant_id: tenantId,
      p_date_from: dateFrom.toISOString(),
      p_date_to: dateTo.toISOString(),
    });
    if (error) return json({ error: error.message }, 500);
    return json({ data });
  }

  if (body.limit !== undefined && !Number.isFinite(body.limit)) {
    return json({ error: "limit debe ser un número." }, 400);
  }
  if (body.stale_days !== undefined && !Number.isFinite(body.stale_days)) {
    return json({ error: "stale_days debe ser un número." }, 400);
  }
  const limit = Math.min(50, Math.max(1, Math.floor(body.limit ?? 10)));
  const staleDays = Math.min(365, Math.max(1, Math.floor(body.stale_days ?? 30)));

  const { data, error } = await adminClient.rpc("get_reports_product_summary", {
    p_tenant_id: tenantId,
    p_date_from: dateFrom.toISOString(),
    p_date_to: dateTo.toISOString(),
    p_limit: limit,
    p_stale_days: staleDays,
  });
  if (error) return json({ error: error.message }, 500);
  return json({ data });
});
