/** Cobro atómico del módulo POS: crea el pedido, lo confirma y registra el
 * pago, todo en una sola llamada -- a diferencia de calculate-order (que es
 * el flujo de borrador editable con autosave del portal, pensado para una
 * cotización que se arma de a poco), acá el cajero escanea, escanea, y toca
 * "Cobrar" una sola vez. Mismo patrón que el `checkout` de storefront/index.ts
 * (resuelve/crea cliente -> inserta sales_orders -> persistOrderItems ->
 * confirmSalesOrder -> resuelve el pago), cambiando la resolución de pago
 * (wompi/crédito) por un insert directo de efectivo/tarjeta.
 *
 * Deliberadamente AFUERA de esta primera ronda (pedido explícito del
 * usuario 2026-09-04, "primero la parte de negocio... omitiendo el tema de
 * envío de facturas a la DIAN"): no se llama sendInvoiceToDian acá. Si el
 * tenant tiene 'dian_directo' activo, apply_sales_order_confirmed_effects
 * (trigger, 20260903180000) igual reserva la fila de sales_invoices como
 * siempre -- queda en 'pending' hasta que una ronda futura conecte el envío
 * síncrono.
 *
 * Sin direcciones ni despacho: la venta nace con sales_channel='pos', que
 * guard_sales_order_confirmation (20260904..._pos_guard_confirmation_skip_address)
 * ya sabe saltarse para el bloque de direcciones -- el chequeo de stock real
 * sigue aplicando igual que cualquier otro canal.
 *
 * Auth: JWT del cajero (tenant_agent con el permiso pos.checkout, o
 * tenant_admin/superadmin sin restricción -- mismo has_permission() que ya
 * usa el resto del sistema de roles). tenant_id sale de profiles.tenant_id
 * del caller, nunca de lo que mande el body. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
import { confirmSalesOrder } from "../_shared/orders/confirmSalesOrder.ts";

interface PosCheckoutItem {
  product_id: string;
  variant_id?: string | null;
  quantity: number;
}

interface PosCheckoutBody {
  contact_id?: string | null;
  items?: PosCheckoutItem[];
  payment?: { method?: string; amount?: number; amount_tendered?: number };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: PosCheckoutBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const items = body.items ?? [];
  if (!Array.isArray(items) || items.length === 0) return json({ error: "El carrito está vacío." }, 400);
  for (const item of items) {
    if (!item.product_id) return json({ error: "Cada línea necesita product_id." }, 400);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) return json({ error: "Cantidad inválida." }, 400);
  }
  // Mismo catálogo que sales_order_payments.method en el resto del sistema
  // (ver PAYMENT_METHOD_LABEL_KEY en orderPayments.ts) -- 'wompi' queda
  // afuera porque ese método solo lo escribe payment-webhook-wompi cuando
  // un link se paga de verdad, nunca una selección manual. 'credito' y
  // 'saldo_favor' se aceptan acá igual que en el portal: la validación real
  // (¿el cliente tiene crédito habilitado? ¿alcanza el saldo a favor?) la
  // hacen los triggers apply_credit_payment_charge/apply_store_credit_redemption
  // al insertar, no este código -- un tenant_agent no puede saltárselo
  // mandando el body a mano.
  const VALID_METHODS = ["efectivo", "transferencia", "tarjeta", "credito", "saldo_favor"];
  const method = body.payment?.method;
  if (!method || !VALID_METHODS.includes(method)) return json({ error: "Método de pago inválido." }, 400);
  const paymentAmount = body.payment?.amount;
  if (!Number.isFinite(paymentAmount) || (paymentAmount as number) <= 0) return json({ error: "Monto de pago inválido." }, 400);

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

  const { data: canCheckout } = await callerClient.rpc("has_permission", { p_action_key: "pos.checkout" });
  if (!canCheckout) return json({ error: "No tenés permiso para cobrar en el POS." }, 403);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Resolver contact_id: si vino, confirmar que es de este tenant; si no,
  // el cliente de mostrador sembrado por seed_default_walkin_client.
  let contactId = body.contact_id ?? null;
  if (contactId) {
    const { data: contact } = await callerClient.from("clients").select("id").eq("id", contactId).maybeSingle();
    if (!contact) return json({ error: "Cliente no encontrado." }, 404);
  } else {
    const { data: walkIn } = await adminClient.from("clients").select("id").eq("tenant_id", tenantId).eq("is_walk_in", true).maybeSingle();
    if (!walkIn) return json({ error: "No se encontró el cliente de mostrador del tenant." }, 500);
    contactId = walkIn.id;
  }

  // Resolver cada ítem contra products/product_variants reales -- un
  // escáner es esencialmente un teclado, nunca se confía el precio que
  // mande el navegador.
  const productIds = Array.from(new Set(items.map((i) => i.product_id)));
  const { data: products, error: productsError } = await adminClient
    .from("products")
    .select("id, name, sku, retail_price, tax_type_code, tax_rate, product_variants(id, sku, retail_price, is_active)")
    .eq("tenant_id", tenantId)
    .in("id", productIds);
  if (productsError) return json({ error: productsError.message }, 500);
  const productById = new Map((products ?? []).map((p) => [p.id, p]));

  const resolvedItems: ResolvedOrderItem[] = [];
  for (const item of items) {
    const product = productById.get(item.product_id);
    if (!product) return json({ error: `Producto no encontrado (${item.product_id}).` }, 404);
    let unitPrice = product.retail_price ?? 0;
    let sku = product.sku;
    if (item.variant_id) {
      const variant = (product.product_variants ?? []).find((v: { id: string }) => v.id === item.variant_id);
      if (!variant) return json({ error: `Variante no encontrada para "${product.name}".` }, 404);
      unitPrice = variant.retail_price ?? unitPrice;
      sku = variant.sku ?? sku;
    }
    resolvedItems.push({
      product_id: product.id,
      variant_id: item.variant_id || null,
      warehouse_id: null,
      product_name: product.name,
      sku: sku ?? null,
      quantity: item.quantity,
      unit_price: unitPrice,
      discount_amount: 0,
      tax_type_code: product.tax_type_code,
      tax_rate: product.tax_rate,
    });
  }

  // Nace en 'cotizacion' porque persistOrderItems/confirmSalesOrder esperan
  // ese punto de partida (mismo criterio que calculate-order) -- se confirma
  // dos pasos más abajo, ya con los ítems reales cargados.
  const { data: newOrder, error: insertError } = await adminClient
    .from("sales_orders")
    .insert({
      tenant_id: tenantId,
      contact_id: contactId,
      sales_channel: "pos",
      status: "cotizacion",
      subtotal: 0,
      discount_total: 0,
      total: 0,
      tax_total: 0,
      shipping: 0,
      created_by: caller.id,
    })
    .select("id")
    .single();
  if (insertError) return json({ error: insertError.message }, 500);
  const orderId = newOrder.id as string;

  try {
    await persistOrderItems(adminClient, tenantId, orderId, resolvedItems, 0);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  const confirmResult = await confirmSalesOrder(adminClient, tenantId, contactId as string, orderId);
  if (confirmResult.blocked) {
    // Sin stock real -- la venta no llegó a confirmarse, queda la
    // cotización huérfana en la base (mismo comportamiento que el resto del
    // sistema ante un stock insuficiente, no se borra nada).
    const reasonMessage =
      confirmResult.reason === "insufficient_stock"
        ? (confirmResult.detail ?? "Stock insuficiente.")
        : "No se pudo confirmar la venta -- faltan datos requeridos.";
    return json({ error: reasonMessage }, 409);
  }

  const paidAt = new Date().toISOString().slice(0, 10);
  const notes = body.payment?.amount_tendered
    ? `Recibido: ${body.payment.amount_tendered} · Vuelto: ${Math.max(0, body.payment.amount_tendered - (paymentAmount as number))}`
    : null;
  const { error: paymentError } = await adminClient.from("sales_order_payments").insert({
    tenant_id: tenantId,
    order_id: orderId,
    method,
    amount: paymentAmount,
    paid_at: paidAt,
    notes,
    created_by: caller.id,
  });
  if (paymentError) return json({ error: paymentError.message }, 500);

  // Si el tenant tiene DIAN activo, apply_sales_order_confirmed_effects ya
  // reservó la fila de sales_invoices (queda 'pending' -- el envío síncrono
  // es una ronda futura, ver comentario de cabecera). Se informa igual acá
  // para que el frontend sepa si hay algo que mostrar.
  const { data: invoice } = await adminClient
    .from("sales_invoices")
    .select("id, status, cufe, status_detail")
    .eq("order_id", orderId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: order } = await adminClient.from("sales_orders").select("id, number, subtotal, total, tax_total, currency").eq("id", orderId).single();

  return json({ order, invoice: invoice ?? null });
});
