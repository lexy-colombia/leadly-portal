/** Paginación real (offset en la DB, .range()) para la pantalla "Órdenes"
 * del portal (Orders.tsx). Reemplaza el listOrders(tenantId) sin límite que
 * traía TODO el historial del tenant al navegador -- un tenant real ya tiene
 * 23.051 pedidos, así que ni siquiera "traer todo en tandas" del lado del
 * cliente es viable, mucho menos un solo select (PostgREST corta en 1000
 * filas por request, db.max_rows).
 *
 * Devuelve, en una sola llamada: la página pedida (con `count` real de
 * PostgREST vía { count: 'exact' }) y el resumen agregado (total vendido/
 * pagado/pendiente/por método/ranking de mesas), calculado en Postgres
 * (get_sales_orders_summary, ver migración 20260904220000) para que nunca
 * dependa de traer todas las filas a ningún lado, ni al navegador ni acá.
 *
 * Auth: JWT del propio caller (mismo patrón que calculate-order/
 * whatsapp-send-human) -- tenant_id sale de profiles.tenant_id del caller,
 * nunca de lo que mande el body. Las consultas reales corren con el admin
 * client (service role, sin RLS) porque get_sales_orders_summary no puede
 * respetar RLS de todos modos al no ejecutarse por fila -- por eso todo acá
 * filtra `tenant_id = tenantId` explícito, igual que calculate-order. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

// Mismos joins que el ORDER_SELECT de lib/api/orders.ts, más `payments`
// embebido (method/amount por orden) para que la columna "Método de pago"
// de la tabla no necesite un fetch aparte de sales_order_payments -- acotado
// a la página actual (PAGE_SIZE filas), no al tenant completo como antes.
const ORDER_SELECT =
  "*, contact:clients(full_name, phone_prefix, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(label, line1, city, state_province), billing_address:contact_addresses!billing_address_id(label, line1, city), items:sales_order_items(count), payments:sales_order_payments(method, amount)";

interface ListSalesOrdersBody {
  page?: number;
  page_size?: number;
  status?: string | null;
  channel?: string | null;
  contact_id?: string | null;
  /** YYYY-MM-DD, ambos inclusive desde la perspectiva del usuario -- se
   * resuelven acá a [date_from 00:00, date_to+1día) igual que
   * resolveDateRange en Orders.tsx. */
  date_from?: string | null;
  date_to?: string | null;
  search?: string | null;
}

interface OrdersSummaryRow {
  count: number;
  total: number;
  currency: string;
  paid: number;
  pending: number;
  by_method: Record<string, number>;
  top_tables: { table: string; count: number; total: number }[];
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: ListSalesOrdersBody;
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

  // "ORD-23"/"23" matchea el número exacto del pedido; cualquier otro texto
  // se busca contra el nombre del cliente (PostgREST no puede filtrar por
  // una columna de una relación embebida en un .or() simple, así que se
  // resuelve en dos pasos, mismo criterio que categoryIds en products.ts).
  const search = (body.search ?? "").trim();
  let searchNumber: number | null = null;
  let searchContactIds: string[] | null = null;
  if (search) {
    const numeric = search.replace(/^ord-?/i, "");
    searchNumber = /^\d+$/.test(numeric) ? Number(numeric) : null;

    const { data: matches, error: matchError } = await adminClient
      .from("clients")
      .select("id")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .ilike("full_name", `%${search}%`);
    if (matchError) return json({ error: matchError.message }, 500);
    searchContactIds = (matches ?? []).map((c: { id: string }) => c.id as string);
  }
  const searchHasNoMatch = search.length > 0 && searchNumber === null && (searchContactIds?.length ?? 0) === 0;

  const dateFrom = body.date_from ? new Date(`${body.date_from}T00:00:00`).toISOString() : null;
  const dateTo = body.date_to ? new Date(new Date(`${body.date_to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000).toISOString() : null;

  if (searchHasNoMatch) {
    return json({
      data: [],
      count: 0,
      page,
      page_size: pageSize,
      total_pages: 1,
      summary: { count: 0, total: 0, currency: "COP", paid: 0, pending: 0, average: 0, by_method: {}, top_tables: [] },
    });
  }

  // deno-lint-ignore no-explicit-any
  function applyFilters(query: any) {
    let q = query.eq("tenant_id", tenantId).is("deleted_at", null);
    if (body.status) q = q.eq("status", body.status);
    if (body.channel) q = q.eq("sales_channel", body.channel);
    if (body.contact_id) q = q.eq("contact_id", body.contact_id);
    if (dateFrom) q = q.gte("created_at", dateFrom);
    if (dateTo) q = q.lt("created_at", dateTo);
    if (search) {
      const parts: string[] = [];
      if (searchNumber !== null) parts.push(`number.eq.${searchNumber}`);
      if (searchContactIds && searchContactIds.length > 0) parts.push(`contact_id.in.(${searchContactIds.join(",")})`);
      q = parts.length > 0 ? q.or(parts.join(",")) : q.eq("id", NIL_UUID);
    }
    return q;
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const listQuery = applyFilters(adminClient.from("sales_orders").select(ORDER_SELECT, { count: "exact" }))
    .order("created_at", { ascending: false })
    .range(from, to);

  const [{ data: rows, error: listError, count }, { data: summaryRaw, error: summaryError }] = await Promise.all([
    listQuery,
    adminClient.rpc("get_sales_orders_summary", {
      p_tenant_id: tenantId,
      p_status: body.status ?? null,
      p_channel: body.channel ?? null,
      p_contact_id: body.contact_id ?? null,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_search_number: searchNumber,
      p_search_contact_ids: searchContactIds,
    }),
  ]);

  if (listError) return json({ error: listError.message }, 500);
  if (summaryError) return json({ error: summaryError.message }, 500);

  const summary = summaryRaw as OrdersSummaryRow;

  return json({
    data: rows ?? [],
    count: count ?? 0,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
    summary: { ...summary, average: summary.count > 0 ? summary.total / summary.count : 0 },
  });
});
