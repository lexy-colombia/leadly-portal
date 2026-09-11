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
 * Sin direcciones: la venta nace con sales_channel='pos', que
 * guard_sales_order_confirmation (20260904..._pos_guard_confirmation_skip_address)
 * ya sabe saltarse -- una venta de mostrador no tiene envío.
 *
 * Chequeo de stock ANTES de crear nada (2026-09-06, corrige un bug real: una
 * venta se había creado sin que nadie validara inventario): se rechaza acá,
 * antes del primer insert, si algún ítem pide más de lo disponible (sumado
 * en todas las bodegas del tenant -- esta pantalla no tiene selector de
 * bodega) -- no se crea ninguna fila si esto falla. El trigger de DB
 * (guard_sales_order_confirmation, 20260906..._pos_orders_skip_stock_check_and_idempotency)
 * ya NO repite este chequeo al confirmar para sales_channel='pos' -- sería
 * redundante, el filtro real vive acá, antes de que exista nada que
 * confirmar.
 *
 * `checkout_token` (opcional, 2026-09-06): bug real reportado en vivo -- sin
 * esto, cada click en "Cobrar" que llegaba a ejecutarse (por ej. si el
 * registro del pago fallaba por una razón transitoria) insertaba una
 * `sales_orders` nueva desde cero, y el cajero terminaba con varias
 * cotizaciones/ventas duplicadas de la misma cuenta. El frontend genera un
 * uuid una sola vez por intento de cobro y lo reenvía tal cual en cada
 * reintento -- si ya existe un pedido con ese token para este tenant, se
 * retoma esa MISMA fila (confirma si no confirmó, cobra si no cobró) en vez
 * de crear otra.
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
import { findStockShortfalls } from "../_shared/orders/stockAvailability.ts";

interface PosCheckoutItem {
  product_id: string;
  variant_id?: string | null;
  quantity: number;
}

interface PosCheckoutPayment {
  method?: string;
  amount?: number;
  amount_tendered?: number;
}

interface PosCheckoutBody {
  contact_id?: string | null;
  items?: PosCheckoutItem[];
  /** Uno o varios métodos de pago para la misma venta (pago dividido) --
   * pedido explícito del usuario 2026-09-11: antes de esto, dividir un
   * cobro entre dos métodos obligaba a cobrar todo con uno y después ir a
   * Ventas a buscar el pedido para agregar el resto -- esta pantalla no
   * tiene concepto de "saldo pendiente" para cuadrar después, así que la
   * suma de los montos tiene que dar EXACTO el total real de la venta
   * (calculado acá, nunca el que mande el cliente). */
  payments?: PosCheckoutPayment[];
  /** @deprecated usar `payments` -- se sigue aceptando por compatibilidad
   * hacia atrás, se normaliza a `payments: [payment]` antes de validar. */
  payment?: PosCheckoutPayment;
  checkout_token?: string | null;
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
  const rawPayments: PosCheckoutPayment[] = body.payments && body.payments.length > 0 ? body.payments : body.payment ? [body.payment] : [];
  if (rawPayments.length === 0) return json({ error: "Falta el pago." }, 400);
  for (const p of rawPayments) {
    if (!p.method || !VALID_METHODS.includes(p.method)) return json({ error: "Método de pago inválido." }, 400);
    if (!Number.isFinite(p.amount) || (p.amount as number) <= 0) return json({ error: "Monto de pago inválido." }, 400);
  }
  const paymentsTotal = rawPayments.reduce((sum, p) => sum + (p.amount as number), 0);

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

  // Idempotencia (ver comentario de cabecera): si este checkout_token ya
  // generó un pedido en un intento anterior (uno que falló después de
  // insertarlo, ej. un timeout al registrar el pago), se retoma esa MISMA
  // fila -- nunca se inserta una segunda `sales_orders` para el mismo
  // intento de cobro.
  const checkoutToken = body.checkout_token || null;
  let orderId: string | null = null;
  let alreadyConfirmed = false;
  if (checkoutToken) {
    const { data: existingOrder, error: existingOrderError } = await adminClient
      .from("sales_orders")
      .select("id, status")
      .eq("tenant_id", tenantId)
      .eq("checkout_token", checkoutToken)
      .maybeSingle();
    if (existingOrderError) return json({ error: existingOrderError.message }, 500);
    if (existingOrder) {
      orderId = existingOrder.id as string;
      alreadyConfirmed = existingOrder.status === "confirmada";
    }
  }

  if (!orderId) {
    // Rechazo duro -- ver comentario de cabecera. Antes de insertar nada.
    const shortfalls = await findStockShortfalls(
      adminClient,
      tenantId,
      resolvedItems.map((item) => ({ product_id: item.product_id, variant_id: item.variant_id, warehouse_id: item.warehouse_id, product_name: item.product_name, quantity: item.quantity })),
    );
    if (shortfalls.length > 0) {
      const detail = shortfalls.map((s) => `"${s.product_name}" (disponible ${s.available}, pedido ${s.requested})`).join(", ");
      return json({ error: `Sin stock suficiente para: ${detail}.` }, 409);
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
        checkout_token: checkoutToken,
      })
      .select("id")
      .single();
    if (insertError) return json({ error: insertError.message }, 500);
    orderId = newOrder.id as string;

    try {
      await persistOrderItems(adminClient, tenantId, orderId, resolvedItems, 0);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // A esta altura orderId siempre está resuelto (viene del lookup por token
  // o de la fila recién insertada).
  const resolvedOrderId = orderId as string;

  if (!alreadyConfirmed) {
    const confirmResult = await confirmSalesOrder(adminClient, tenantId, contactId as string, resolvedOrderId);
    if (confirmResult.blocked) {
      // Con sales_channel='pos' el trigger ya no bloquea por stock (ver
      // 20260906..._pos_orders_skip_stock_check_and_idempotency) -- si esto
      // dispara igual es por otra razón real (ej. el pedido no estaba en
      // 'cotizacion'), la cotización queda tal cual, sin borrar nada.
      const reasonMessage =
        confirmResult.reason === "insufficient_stock"
          ? (confirmResult.detail ?? "Stock insuficiente.")
          : "No se pudo confirmar la venta -- faltan datos requeridos.";
      return json({ error: reasonMessage }, 409);
    }
  }

  // Idem para el pago: si un intento anterior con este mismo token ya lo
  // registró, no se duplica -- se sigue de largo con lo que ya quedó.
  const { data: existingPayments, error: existingPaymentsError } = await adminClient
    .from("sales_order_payments")
    .select("id")
    .eq("order_id", resolvedOrderId)
    .is("deleted_at", null)
    .limit(1);
  if (existingPaymentsError) return json({ error: existingPaymentsError.message }, 500);
  if (!existingPayments || existingPayments.length === 0) {
    // El total real recién se conoce después de persistOrderItems/confirmar
    // (esta pantalla no tiene selector de bodega/descuentos que el cajero
    // pueda desalinear, pero el impuesto sí lo recalcula el servidor) --
    // nunca se confía en la suma que mande el cliente sin comparar contra
    // lo que de verdad quedó guardado. Sin concepto de "saldo pendiente"
    // acá (a diferencia de calculate-order/PaymentDrawer): o los pagos
    // suman el total exacto, o se rechaza el cobro entero.
    const { data: orderForTotal, error: orderForTotalError } = await adminClient.from("sales_orders").select("total").eq("id", resolvedOrderId).single();
    if (orderForTotalError) return json({ error: orderForTotalError.message }, 500);
    const realTotal = Number(orderForTotal.total);
    if (Math.abs(paymentsTotal - realTotal) > 0.01) {
      return json({ error: `La suma de los pagos (${paymentsTotal}) no coincide con el total de la venta (${realTotal}).` }, 400);
    }

    const paidAt = new Date().toISOString().slice(0, 10);
    const rows = rawPayments.map((p) => ({
      tenant_id: tenantId,
      order_id: resolvedOrderId,
      method: p.method,
      amount: p.amount,
      paid_at: paidAt,
      notes: p.amount_tendered ? `Recibido: ${p.amount_tendered} · Vuelto: ${Math.max(0, p.amount_tendered - (p.amount as number))}` : null,
      created_by: caller.id,
    }));
    const { error: paymentError } = await adminClient.from("sales_order_payments").insert(rows);
    if (paymentError) return json({ error: paymentError.message }, 500);
  }

  // Si el tenant tiene DIAN activo, apply_sales_order_confirmed_effects ya
  // reservó la fila de sales_invoices (queda 'pending' -- el envío síncrono
  // es una ronda futura, ver comentario de cabecera). Se informa igual acá
  // para que el frontend sepa si hay algo que mostrar.
  const { data: invoice } = await adminClient
    .from("sales_invoices")
    .select("id, status, cufe, status_detail")
    .eq("order_id", resolvedOrderId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: order } = await adminClient.from("sales_orders").select("id, number, subtotal, total, tax_total, currency").eq("id", resolvedOrderId).single();

  return json({ order, invoice: invoice ?? null });
});
