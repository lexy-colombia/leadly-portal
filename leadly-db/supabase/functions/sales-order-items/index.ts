/** Único punto de escritura para "reemplazar los ítems de un pedido y
 * recalcular sus totales" desde el portal -- antes el frontend (lib/api/orders.ts)
 * hacía este cálculo por su cuenta con supabase-js directo, una tercera
 * reimplementación del mismo impuesto/totales que ya tenían
 * whatsapp-ai-tools y storefront (y que se desalineó de las otras dos: el
 * portal sumaba el impuesto al total en vez de extraerlo). Pedido explícito
 * del usuario 2026-09-03: centralizar todo en un solo lugar server-side,
 * sin importar quién llama -- esta función y las otras dos ahora comparten
 * literalmente el mismo código (_shared/orders/persistOrderItems.ts).
 *
 * A diferencia de whatsapp-ai-tools/storefront (que resuelven el producto
 * por nombre o desde el carrito y ya conocen su tax_type_code/tax_rate),
 * el portal solo manda product_id -- el impuesto de cada línea se resuelve
 * ACÁ, del lado del servidor, contra la tabla products real, nunca
 * confiando en lo que el navegador diga que es la tasa (el frontend podría
 * tener datos viejos, o directamente mentir).
 *
 * Auth: JWT del propio caller (mismo patrón que whatsapp-send-human) -- la
 * pertenencia del pedido al tenant se confirma leyéndolo con el client del
 * caller (RLS hace el aislamiento), la escritura real usa el admin client
 * porque products/sales_order_items no tienen por qué ser legibles/
 * escribibles directo por un tenant_agent fuera de este flujo controlado. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";

interface RawItemInput {
  product_id?: string | null;
  variant_id?: string | null;
  warehouse_id?: string | null;
  product_name: string;
  sku?: string | null;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { order_id?: string; items?: RawItemInput[]; shipping?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { order_id, items, shipping } = body;
  if (!order_id || !Array.isArray(items)) return json({ error: "order_id e items son requeridos." }, 400);
  for (const item of items) {
    if (!item.product_name?.trim()) return json({ error: "Cada línea necesita product_name." }, 400);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) return json({ error: `Cantidad inválida para "${item.product_name}".` }, 400);
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0) return json({ error: `Precio inválido para "${item.product_name}".` }, 400);
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

  // RLS de sales_orders ya aísla por tenant -- si el pedido es de otro
  // tenant, esto viene null, igual que "no existe".
  const { data: order } = await callerClient.from("sales_orders").select("id, tenant_id").eq("id", order_id).maybeSingle();
  if (!order) return json({ error: "Pedido no encontrado." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id)));
  const productTaxById = new Map<string, { tax_type_code: string | null; tax_rate: number }>();
  if (productIds.length > 0) {
    // Filtro de tenant explícito -- el admin client no tiene RLS, así que
    // sin esto un product_id de OTRO tenant igual resolvería su
    // tax_type_code/tax_rate real. order.tenant_id ya viene confirmado
    // arriba vía callerClient (RLS), es el tenant real del pedido.
    const { data: products, error: productsError } = await adminClient
      .from("products")
      .select("id, tax_type_code, tax_rate")
      .eq("tenant_id", order.tenant_id)
      .in("id", productIds);
    if (productsError) return json({ error: productsError.message }, 500);
    for (const p of products ?? []) productTaxById.set(p.id, { tax_type_code: p.tax_type_code, tax_rate: p.tax_rate });
  }

  const resolvedItems: ResolvedOrderItem[] = items.map((item) => {
    const productTax = item.product_id ? productTaxById.get(item.product_id) : undefined;
    return {
      product_id: item.product_id || null,
      variant_id: item.variant_id || null,
      warehouse_id: item.warehouse_id || null,
      product_name: item.product_name,
      sku: item.sku || null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_amount: item.discount_amount ?? 0,
      tax_type_code: productTax?.tax_type_code ?? null,
      tax_rate: productTax?.tax_rate ?? 0,
    };
  });

  try {
    await persistOrderItems(adminClient, order.tenant_id, order.id, resolvedItems, shipping ?? 0);
    // Devuelve la fila completa ya actualizada -- el frontend no necesita
    // un segundo viaje solo para refrescar lo que esta función ya escribió.
    const { data: updatedOrder, error: reloadError } = await adminClient.from("sales_orders").select("*").eq("id", order.id).single();
    if (reloadError) return json({ error: reloadError.message }, 500);
    return json(updatedOrder);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
