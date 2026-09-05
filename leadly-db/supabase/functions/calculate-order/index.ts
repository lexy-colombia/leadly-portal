/** ÚNICA puerta de escritura para armar un CARRITO (pre-pedido): cliente,
 * oportunidad, notas, direcciones de envío/facturación, envío, e ítems --
 * todo en una sola llamada, con debounce (2s de inactividad) del lado del
 * caller en vez de un guardado por cada campo suelto. La usan tanto
 * Órdenes del portal como el POS, con el mismo mecanismo -- nunca hay una
 * segunda copia de esta lógica en ningún otro lugar.
 *
 * Rediseño 2026-09-04 (pedido explícito del usuario, cuarta iteración del
 * plan de "cuentas abiertas" de POS): esta función YA NO crea pedidos.
 * - Con `order_id`: exactamente el comportamiento de siempre, sin cambios
 *   -- edita un pedido que YA es real (candados de bloqueo, headerPatch,
 *   persistOrderItems directo a sales_order_items).
 * - Sin `order_id`: en vez de crear un `sales_orders`, crea/edita un
 *   `carts` (con `cart_id` para seguir editando el mismo borrador, o sin
 *   él para arrancar uno nuevo). Nunca toca `sales_orders`. El único lugar
 *   que sí crea el pedido real es la Edge Function `create-order`, a
 *   partir de un `cart_id` -- ese es el momento explícito en que el
 *   usuario aprieta "Crear pedido" (portal) o "Cobrar" (POS).
 *
 * Regla permanente, no solo de esta función: el frontend NUNCA pre-valida
 * nada (stock, variantes, direcciones) antes de llamar a este endpoint --
 * se llama, y se muestra el error que devuelva. Ver memoria de sesión
 * "no frontend validation" -- esto es lo que la originó.
 *
 * Deliberadamente AFUERA de este alcance:
 * - Pagos (sales_order_payments) -- es una transacción financiera con su
 *   propio flujo (PaymentDrawer, Wompi, crédito), no un campo editable del
 *   pedido en borrador. Decisión explícita del usuario.
 * - Confirmar el pedido (status -> 'confirmada') -- ya tiene su propia
 *   validación robusta a nivel de DB (triggers
 *   guard_sales_order_confirmation / apply_sales_order_confirmed_effects,
 *   20260903180000), que necesita los ítems YA guardados para poder
 *   chequear stock de verdad.
 *
 * El impuesto de cada ítem NUNCA se resuelve acá cuando se opera sobre un
 * carrito (eso pasa una sola vez, en create-order) -- solo se resuelve
 * cuando la rama `order_id` edita un pedido ya real, igual que siempre.
 *
 * Con `preview: true` no escribe nada: solo devuelve el desglose
 * (base gravable / impuesto por tarifa / total) de los ítems que se le
 * manden, para que el POS pueda mostrar qué va a cobrar antes de cobrar.
 *
 * Auth: JWT del propio caller (mismo patrón que whatsapp-send-human) --
 * tenant_id sale de profiles.tenant_id del caller, nunca de lo que mande
 * el body. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
import { computeOrderTotals } from "../_shared/orders/computeOrderTotals.ts";
import { isTenantTaxEnabled } from "../_shared/invoicing/queueInvoiceGeneration.ts";
import { corsHeaders } from "../_shared/cors.ts";

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

interface CalculateOrderBody {
  /** Solo lectura: devuelve el desglose (base gravable, impuesto por
   * tarifa, total) de una lista de ítems SIN escribir absolutamente nada
   * -- ni carrito, ni pedido. Existe para que el POS pueda mostrar el
   * resumen de lo que va a cobrar antes de cobrarlo sin que el frontend
   * calcule impuestos por su cuenta (regla del proyecto: cero cálculos de
   * negocio en el cliente). Usa el mismo computeOrderTotals que
   * persistOrderItems, así el preview y el pedido real no pueden
   * discrepar. */
  preview?: boolean;
  order_id?: string | null;
  cart_id?: string | null;
  contact_id?: string;
  opportunity_id?: string | null;
  notes?: string | null;
  valid_until?: string | null;
  shipping_address_id?: string | null;
  billing_address_id?: string | null;
  shipping?: number;
  items?: RawItemInput[];
  origin?: "portal" | "pos";
  pos_point_id?: string | null;
  label?: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  // El navegador manda un preflight OPTIONS antes del POST real -- sin
  // responder esto con los headers CORS, el fetch del portal fallaba
  // directo con "Failed to send a request to the Edge Function" (nunca se
  // notó antes porque todas las pruebas de esta función fueron por curl,
  // que no aplica CORS). Encontrado en vivo 2026-09-03.
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: CalculateOrderBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const items = body.items ?? [];
  if (!Array.isArray(items)) return json({ error: "items debe ser una lista." }, 400);
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

  const { data: profile } = await callerClient.from("profiles").select("tenant_id").eq("id", caller.id).maybeSingle();
  if (!profile?.tenant_id) return json({ error: "No se pudo resolver el tenant del usuario." }, 403);
  const tenantId = profile.tenant_id as string;

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Ningún id que mande el body se escribe a ciegas -- se confirma que sea
  // del mismo tenant del caller ANTES de usarlo en cualquier insert/update
  // (headerPatch de un pedido, o el carrito nuevo/existente más abajo).
  // Mismo criterio que resolveOrderAddress en el storefront y el chequeo de
  // tenant_role_id en admin-create-tenant-user: nunca confiar en un id
  // ajeno sin comprobar dueño primero. Sin esto, un tenant_agent podía
  // enlazar su propio pedido/carrito al contacto o la dirección de OTRO
  // tenant con solo conocer/adivinar el UUID.
  const ownershipChecks: { field: string; table: string; id: string | null | undefined }[] = [
    { field: "contact_id", table: "clients", id: body.contact_id },
    { field: "opportunity_id", table: "opportunities", id: body.opportunity_id },
    { field: "shipping_address_id", table: "contact_addresses", id: body.shipping_address_id },
    { field: "billing_address_id", table: "contact_addresses", id: body.billing_address_id },
  ];
  for (const check of ownershipChecks) {
    if (!check.id) continue;
    const { data: owned } = await adminClient.from(check.table).select("id").eq("id", check.id).eq("tenant_id", tenantId).maybeSingle();
    if (!owned) return json({ error: `${check.field} no pertenece a este tenant.` }, 403);
  }

  if (body.preview) {
    const taxEnabled = await isTenantTaxEnabled(adminClient, tenantId);
    const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id)));
    const taxById = new Map<string, { tax_type_code: string | null; tax_rate: number }>();
    if (taxEnabled && productIds.length > 0) {
      // Acotado al propio tenant: el impuesto se resuelve contra la tabla
      // real, nunca contra lo que mande el body (mismo criterio que la
      // rama con order_id).
      const { data: products, error: productsError } = await adminClient
        .from("products")
        .select("id, tax_type_code, tax_rate")
        .eq("tenant_id", tenantId)
        .in("id", productIds);
      if (productsError) return json({ error: productsError.message }, 500);
      for (const p of products ?? []) taxById.set(p.id, { tax_type_code: p.tax_type_code, tax_rate: p.tax_rate });
    }
    const totals = computeOrderTotals(
      items.map((item) => {
        const productTax = item.product_id ? taxById.get(item.product_id) : undefined;
        return {
          quantity: item.quantity,
          unit_price: item.unit_price,
          discount_amount: item.discount_amount ?? 0,
          tax_type_code: productTax?.tax_type_code ?? null,
          tax_rate: productTax?.tax_rate ?? 0,
        };
      }),
      body.shipping ?? 0,
      taxEnabled,
    );
    return json({
      totals: {
        tax_enabled: taxEnabled,
        subtotal: totals.subtotal,
        discount_total: totals.discountTotal,
        taxable_base: totals.taxableBase,
        tax_total: totals.taxTotal,
        shipping: totals.shipping,
        total: totals.total,
        tax_lines: totals.taxLines,
      },
    });
  }

  const orderId = body.order_id ?? null;

  if (orderId) {
    // RLS de sales_orders ya aísla por tenant -- si el pedido es de otro
    // tenant, esto viene null, igual que "no existe".
    const { data: existingOrder } = await callerClient.from("sales_orders").select("id, status, delivery_status").eq("id", orderId).maybeSingle();
    if (!existingOrder) return json({ error: "Pedido no encontrado." }, 404);

    // Única puerta de escritura de la composición del pedido (cliente,
    // direcciones, envío, ítems/precios). Candado real -- el frontend
    // deshabilita los campos como UX (ver `locked` en OrderDetail.tsx), pero
    // quien de verdad lo impide es este chequeo, por si alguien llama la
    // función directo sin pasar por la UI. Reglas exactas confirmadas con
    // el usuario 2026-09-04 (basta UNA para bloquear, no hace falta que se
    // den las tres juntas):
    // - la factura DIAN vigente ya quedó 'sent'/'accepted' (documento
    //   fiscal real ya transmitido -- si en cambio está rechazada/pendiente/
    //   no existe, sigue editable a propósito, para poder corregir y
    //   reintentar);
    // - el pedido ya tuvo algún movimiento de despacho. OJO -- con el
    //   módulo de Despachos habilitado, sales_orders.delivery_status NUNCA
    //   se sincroniza (confirmado leyendo log_dispatch_status_change(): solo
    //   escribe dispatch_status_history, no toca delivery_status) -- la
    //   señal real ahí es que exista una fila en `dispatches` para este
    //   pedido, sin importar en qué estado. Sin el módulo, delivery_status
    //   sigue siendo la única vía (el select simple sí lo escribe directo).
    //   Hay que chequear las dos.
    // - el pedido está anulado.
    // Una cotización, o una venta confirmada que todavía no se despachó ni
    // facturó ante la DIAN, sigue siendo 100% editable -- no se bloquea
    // "apenas se confirma".
    const [{ data: latestInvoice }, { data: dispatchRow }] = await Promise.all([
      callerClient.from("sales_invoices").select("status").eq("order_id", orderId).order("attempt_number", { ascending: false }).limit(1).maybeSingle(),
      callerClient.from("dispatches").select("id").eq("sales_order_id", orderId).maybeSingle(),
    ]);
    const dianLocked = latestInvoice?.status === "sent" || latestInvoice?.status === "accepted";
    const dispatchLocked = !!dispatchRow || existingOrder.delivery_status !== "pendiente";
    const cancelledLocked = existingOrder.status === "cancelada";
    if (dianLocked || dispatchLocked || cancelledLocked) {
      return json({ error: "Este pedido ya no se puede modificar (factura DIAN enviada/aceptada, despachado, o anulado)." }, 409);
    }

    const headerPatch: Record<string, unknown> = {};
    if (body.contact_id !== undefined) headerPatch.contact_id = body.contact_id;
    if (body.opportunity_id !== undefined) headerPatch.opportunity_id = body.opportunity_id;
    if (body.notes !== undefined) headerPatch.notes = body.notes;
    if (body.valid_until !== undefined) headerPatch.valid_until = body.valid_until;
    if (body.shipping_address_id !== undefined) headerPatch.shipping_address_id = body.shipping_address_id;
    if (body.billing_address_id !== undefined) headerPatch.billing_address_id = body.billing_address_id;
    if (Object.keys(headerPatch).length > 0) {
      const { error: headerError } = await adminClient.from("sales_orders").update(headerPatch).eq("id", orderId);
      if (headerError) return json({ error: headerError.message }, 500);
    }

    const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id)));
    const productTaxById = new Map<string, { tax_type_code: string | null; tax_rate: number }>();
    if (productIds.length > 0) {
      // Filtro de tenant explícito -- el admin client no tiene RLS, así que
      // sin esto un product_id de OTRO tenant igual resolvería su
      // tax_type_code/tax_rate real.
      const { data: products, error: productsError } = await adminClient.from("products").select("id, tax_type_code, tax_rate").eq("tenant_id", tenantId).in("id", productIds);
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
      await persistOrderItems(adminClient, tenantId, orderId, resolvedItems, body.shipping ?? 0);
      const { data: updatedOrder, error: reloadError } = await adminClient.from("sales_orders").select("*").eq("id", orderId).single();
      if (reloadError) return json({ error: reloadError.message }, 500);
      return json(updatedOrder);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // Sin order_id: esto opera sobre un CARRITO, nunca sobre sales_orders
  // (ver comentario de cabecera). Sin impuesto resuelto acá -- se calcula
  // una sola vez, en create-order, al convertir.
  let cartId = body.cart_id ?? null;

  if (cartId) {
    const { data: existingCart } = await callerClient.from("carts").select("id, status").eq("id", cartId).maybeSingle();
    if (!existingCart) return json({ error: "Carrito no encontrado." }, 404);
    if (existingCart.status !== "open") return json({ error: "Este carrito ya no está abierto." }, 409);

    const cartPatch: Record<string, unknown> = { last_activity_at: new Date().toISOString() };
    if (body.contact_id !== undefined) cartPatch.contact_id = body.contact_id;
    if (body.opportunity_id !== undefined) cartPatch.opportunity_id = body.opportunity_id;
    if (body.notes !== undefined) cartPatch.notes = body.notes;
    if (body.valid_until !== undefined) cartPatch.valid_until = body.valid_until;
    if (body.shipping_address_id !== undefined) cartPatch.shipping_address_id = body.shipping_address_id;
    if (body.billing_address_id !== undefined) cartPatch.billing_address_id = body.billing_address_id;
    if (body.shipping !== undefined) cartPatch.shipping = body.shipping;
    if (body.pos_point_id !== undefined) cartPatch.pos_point_id = body.pos_point_id;
    if (body.label !== undefined) cartPatch.label = body.label;
    const { error: cartPatchError } = await adminClient.from("carts").update(cartPatch).eq("id", cartId);
    if (cartPatchError) return json({ error: cartPatchError.message }, 500);
  } else {
    if (!body.contact_id) return json({ error: "contact_id es requerido para crear un carrito." }, 400);
    const { data: newCart, error: cartInsertError } = await adminClient
      .from("carts")
      .insert({
        tenant_id: tenantId,
        contact_id: body.contact_id,
        opportunity_id: body.opportunity_id ?? null,
        notes: body.notes ?? null,
        valid_until: body.valid_until ?? null,
        shipping_address_id: body.shipping_address_id ?? null,
        billing_address_id: body.billing_address_id ?? null,
        shipping: body.shipping ?? 0,
        origin: body.origin ?? "portal",
        pos_point_id: body.pos_point_id ?? null,
        label: body.label ?? null,
      })
      .select("id")
      .single();
    if (cartInsertError) return json({ error: cartInsertError.message }, 500);
    cartId = newCart.id;
  }

  // Reemplaza todos los cart_items -- mismo criterio "reemplaza todo, no
  // hace merge/diff" que ya usa persistOrderItems, sin impuesto.
  const { error: deleteItemsError } = await adminClient.from("cart_items").delete().eq("cart_id", cartId);
  if (deleteItemsError) return json({ error: deleteItemsError.message }, 500);
  if (items.length > 0) {
    const { error: insertItemsError } = await adminClient.from("cart_items").insert(
      items.map((item) => ({
        cart_id: cartId,
        product_id: item.product_id || null,
        variant_id: item.variant_id || null,
        warehouse_id: item.warehouse_id || null,
        product_name: item.product_name,
        sku: item.sku || null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_amount: item.discount_amount ?? 0,
      })),
    );
    if (insertItemsError) return json({ error: insertItemsError.message }, 500);
  }

  const { data: cart, error: reloadCartError } = await adminClient.from("carts").select("*, items:cart_items(*)").eq("id", cartId).single();
  if (reloadCartError) return json({ error: reloadCartError.message }, 500);
  return json({ cart });
});
