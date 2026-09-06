/** Paginación real (offset en la DB, .range()) para la pantalla "Gastos"
 * del portal (ExpensesTab.tsx) -- mismo problema y misma solución que
 * list-sales-orders: el tenant real ya tiene 6072 gastos migrados de Fudo,
 * y PostgREST corta cualquier select en 1000 filas por request
 * (db.max_rows). El viejo listExpenses(tenantId, filters) traía todo el
 * historial filtrado de una sola vez y paginaba recién en el navegador --
 * con más de 1000 filas, el resto quedaba invisible sin ningún error.
 *
 * Devuelve, en una sola llamada: la página pedida (con `count` real de
 * PostgREST vía { count: 'exact' }) y el resumen agregado (cantidad + total
 * en dinero), calculado en Postgres (get_expenses_summary, ver migración
 * 20260906190000) para que nunca dependa de traer todas las filas a ningún
 * lado, ni al navegador ni acá.
 *
 * Auth: JWT del propio caller (mismo patrón que list-sales-orders) --
 * tenant_id sale de profiles.tenant_id del caller, nunca de lo que mande el
 * body. Las consultas reales corren con el admin client (service role, sin
 * RLS) porque get_expenses_summary no puede respetar RLS al no ejecutarse
 * por fila -- por eso todo acá filtra `tenant_id = tenantId` explícito. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const EXPENSE_SELECT = "*, supplier:suppliers(id, name), category:expense_categories(id, name)";

interface ListExpensesBody {
  page?: number;
  page_size?: number;
  supplier_id?: string | null;
  category_id?: string | null;
  /** YYYY-MM-DD, ambos inclusive. */
  date_from?: string | null;
  date_to?: string | null;
}

interface ExpensesSummaryRow {
  count: number;
  total: number;
  currency: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: ListExpensesBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const page = Math.max(1, Math.floor(body.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(body.page_size ?? 10)));

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

  const dateFrom = body.date_from ?? null;
  const dateTo = body.date_to ?? null;

  // deno-lint-ignore no-explicit-any
  function applyFilters(query: any) {
    let q = query.eq("tenant_id", tenantId).is("deleted_at", null);
    if (body.supplier_id) q = q.eq("supplier_id", body.supplier_id);
    if (body.category_id) q = q.eq("category_id", body.category_id);
    if (dateFrom) q = q.gte("expense_date", dateFrom);
    if (dateTo) q = q.lte("expense_date", dateTo);
    return q;
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const listQuery = applyFilters(adminClient.from("expenses").select(EXPENSE_SELECT, { count: "exact" }))
    .order("expense_date", { ascending: false })
    .range(from, to);

  const [{ data: rows, error: listError, count }, { data: summaryRaw, error: summaryError }] = await Promise.all([
    listQuery,
    adminClient.rpc("get_expenses_summary", {
      p_tenant_id: tenantId,
      p_supplier_id: body.supplier_id ?? null,
      p_category_id: body.category_id ?? null,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    }),
  ]);

  if (listError) return json({ error: listError.message }, 500);
  if (summaryError) return json({ error: summaryError.message }, 500);

  const summary = summaryRaw as ExpensesSummaryRow;

  return json({
    data: rows ?? [],
    count: count ?? 0,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
    summary,
  });
});
