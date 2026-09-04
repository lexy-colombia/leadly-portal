/** ÚNICO lugar que crea una fila real de `sales_orders`. Todo lo demás
 * (Órdenes del portal, POS) arma su borrador en un `carts` vía
 * `calculate-order`, y recién llama acá en el momento explícito en que el
 * usuario aprieta "Crear pedido" (portal) o "Cobrar" (POS) -- nunca antes.
 *
 * Pedido explícito del usuario 2026-09-04 (cuarta iteración del plan de
 * "cuentas abiertas" de POS): dos endpoints separados, `calculate-order`
 * (arma el carrito, nunca toca sales_orders) y este (crea el pedido real,
 * nunca toca carts salvo para marcarlo convertido). Regla permanente: el
 * frontend nunca pre-valida nada antes de llamar a este endpoint -- se
 * llama, y se muestra el error que devuelva.
 *
 * Nace siempre en 'cotizacion' -- confirmar (status -> 'confirmada') sigue
 * siendo un segundo paso (updateOrderStatus), exactamente igual que ya
 * hacía calculate-order antes de este cambio -- el trigger de
 * confirmación (guard_sales_order_confirmation) necesita los ítems YA
 * guardados para poder chequear stock de verdad.
 *
 * Auth: JWT del propio caller, mismo patrón que calculate-order/
 * pos-checkout -- tenant_id sale de profiles.tenant_id del caller, nunca
 * de lo que mande el body.
 *
 * `confirm` (opcional, 2026-09-04): confirma el pedido en la misma
 * llamada. Existe por una razón concreta de UX: el POS necesitaba crear y
 * confirmar para poder cobrar, y hacerlo en dos viajes (create-order +
 * un update de status aparte) se sentía lento al apretar "Cobrar". La
 * confirmación se hace ANTES de tocar los ítems del carrito: si el trigger
 * la rechaza (stock insuficiente, dirección faltante), la cuenta se queda
 * con todos sus productos intactos en vez de vaciarse por un cobro que no
 * ocurrió. Los mismos triggers de siempre (guard_sales_order_confirmation /
 * apply_sales_order_confirmed_effects) son los que validan -- acá no se
 * duplica ninguna regla.
 *
 * `keep_cart_open` (opcional, 2026-09-04, pedido explícito del usuario):
 * cobrar y cerrar la mesa son dos cosas distintas. Sin este flag (portal),
 * el carrito se marca `converted` apenas queda sin ítems -- era un borrador
 * que se volvió pedido, no tiene sentido que siga vivo. Con el flag en true
 * (POS, cuentas abiertas), el carrito NUNCA se cierra solo: aunque se cobre
 * todo, la cuenta sigue abierta para que la mesa pueda seguir pidiendo, y
 * solo se cierra cuando el cajero lo decide explícitamente (un update a
 * status='converted' desde el POS, ver closeCart en lib/api/carts.ts).
 *
 * `items` (opcional, 2026-09-04): cobrar la cuenta en partes -- dividir la
 * mesa por producto, incluso dentro de una misma línea (2 de 3 cervezas).
 * Sin este campo, se cobra el carrito completo (comportamiento de siempre,
 * lo sigue usando el portal y el "cobrar todo" del POS). Con una lista de
 * `{id, quantity}`, arma el pedido SOLO con esas cantidades: si la
 * cantidad pedida cubre toda la línea, esa línea sale del carrito; si es
 * menor, la línea se queda con el resto (`quantity` del cart_item se
 * descuenta). El carrito sigue `open` mientras le quede algo -- recién se
 * marca `converted` cuando no queda ningún ítem por cobrar. Sin descuento
 * proporcional cuando se divide una línea con discount_amount: ese
 * descuento se aplica completo la primera vez que se cobra esa línea
 * entera, nunca a una fracción -- simplificación deliberada, no hay forma
 * no ambigua de repartir un monto fijo entre unidades sueltas. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
import { corsHeaders } from "../_shared/cors.ts";

interface CreateOrderBody {
  cart_id?: string;
  items?: { id: string; quantity: number }[];
  keep_cart_open?: boolean;
  confirm?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: CreateOrderBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.cart_id) return json({ error: "cart_id es requerido." }, 400);

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

  // RLS de carts ya aísla por tenant -- si el carrito es de otro tenant,
  // esto viene null, igual que "no existe".
  const { data: cart } = await callerClient
    .from("carts")
    .select("id, contact_id, opportunity_id, notes, valid_until, shipping_address_id, billing_address_id, shipping, origin, status, pos_point_id, label")
    .eq("id", body.cart_id)
    .maybeSingle();
  if (!cart) return json({ error: "Carrito no encontrado." }, 404);
  if (cart.status !== "open") return json({ error: "Este carrito ya no está abierto." }, 409);
  if (!cart.contact_id) return json({ error: "El carrito necesita un cliente antes de crear el pedido." }, 400);

  const { data: allCartItems, error: cartItemsError } = await adminClient
    .from("cart_items")
    .select("id, product_id, variant_id, warehouse_id, product_name, sku, quantity, unit_price, discount_amount")
    .eq("cart_id", body.cart_id);
  if (cartItemsError) return json({ error: cartItemsError.message }, 500);
  if (!allCartItems || allCartItems.length === 0) return json({ error: "El carrito no tiene productos." }, 400);

  // selections: cuánto de cada cart_item se cobra en esta pasada. Sin
  // `items` en el body, se cobra la cantidad completa de todas las líneas
  // (comportamiento de siempre).
  type Selection = { cartItem: (typeof allCartItems)[number]; quantity: number };
  let selections: Selection[];
  if (body.items && body.items.length > 0) {
    selections = [];
    for (const sel of body.items) {
      const match = allCartItems.find((i) => i.id === sel.id);
      if (!match) return json({ error: "Alguno de los ítems seleccionados no pertenece a este carrito." }, 400);
      if (!Number.isFinite(sel.quantity) || sel.quantity <= 0 || sel.quantity > match.quantity) {
        return json({ error: `Cantidad inválida para "${match.product_name}".` }, 400);
      }
      selections.push({ cartItem: match, quantity: sel.quantity });
    }
  } else {
    selections = allCartItems.map((cartItem) => ({ cartItem, quantity: cartItem.quantity }));
  }

  // Mismo criterio que ya usaba calculate-order en su insert-path: el
  // impuesto de cada ítem se resuelve acá, contra la tabla products real
  // -- nunca confía en lo que haya quedado guardado en el carrito.
  const productIds = Array.from(new Set(selections.map((s) => s.cartItem.product_id).filter((id): id is string => !!id)));
  const productTaxById = new Map<string, { tax_type_code: string | null; tax_rate: number }>();
  if (productIds.length > 0) {
    const { data: products, error: productsError } = await adminClient.from("products").select("id, tax_type_code, tax_rate").in("id", productIds);
    if (productsError) return json({ error: productsError.message }, 500);
    for (const p of products ?? []) productTaxById.set(p.id, { tax_type_code: p.tax_type_code, tax_rate: p.tax_rate });
  }

  const resolvedItems: ResolvedOrderItem[] = selections.map(({ cartItem: item, quantity }) => {
    const productTax = item.product_id ? productTaxById.get(item.product_id) : undefined;
    // El descuento de la línea solo viaja cuando se cobra la cantidad
    // completa que tenía en ese momento -- ver comentario de cabecera.
    const discount = quantity === item.quantity ? (item.discount_amount ?? 0) : 0;
    return {
      product_id: item.product_id,
      variant_id: item.variant_id,
      warehouse_id: item.warehouse_id,
      product_name: item.product_name,
      sku: item.sku,
      quantity,
      unit_price: item.unit_price,
      discount_amount: discount,
      tax_type_code: productTax?.tax_type_code ?? null,
      tax_rate: productTax?.tax_rate ?? 0,
    };
  });

  const { data: newOrder, error: insertError } = await adminClient
    .from("sales_orders")
    .insert({
      tenant_id: tenantId,
      cart_id: cart.id,
      contact_id: cart.contact_id,
      opportunity_id: cart.opportunity_id,
      notes: cart.notes,
      valid_until: cart.valid_until,
      shipping_address_id: cart.shipping_address_id,
      billing_address_id: cart.billing_address_id,
      status: "cotizacion",
      subtotal: 0,
      discount_total: 0,
      total: 0,
      tax_total: 0,
      shipping: 0,
      // De dónde salió el pedido, para poder distinguirlo en Ventas y
      // para que el POS se salte todo lo de envío. Un carrito del portal
      // es "portal" (antes quedaba en null, indistinguible de los que
      // crea la IA).
      sales_channel: cart.origin === "pos" ? "pos" : "portal",
      pos_point_id: cart.pos_point_id,
      label: cart.label,
      created_by: caller.id,
    })
    .select("id")
    .single();
  if (insertError) return json({ error: insertError.message }, 500);
  const orderId = newOrder.id as string;

  try {
    await persistOrderItems(adminClient, tenantId, orderId, resolvedItems, cart.shipping ?? 0);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  // Confirmar antes de tocar el carrito: si el trigger rechaza (stock,
  // dirección), la cuenta conserva todos sus productos. El prefijo tipo
  // "BILLING_ADDRESS_REQUIRED: " que agrega el trigger se saca acá, igual
  // que hace updateOrderStatus en el frontend -- el resto del texto ya es
  // un mensaje claro en español.
  if (body.confirm) {
    const { error: confirmError } = await adminClient.from("sales_orders").update({ status: "confirmada" }).eq("id", orderId);
    if (confirmError) {
      const cleaned = confirmError.message.replace(/^[A-Z_]+:\s*/, "");
      return json({ error: cleaned || confirmError.message }, 409);
    }
  }

  // Los ítems recién facturados salen del carrito -- si una línea se
  // cobró completa, se borra; si se cobró solo una parte de su cantidad,
  // se le resta lo cobrado y se queda con el resto para la próxima
  // cobrada.
  const fullyBilledIds = selections.filter((s) => s.quantity === s.cartItem.quantity).map((s) => s.cartItem.id);
  const partiallyBilled = selections.filter((s) => s.quantity < s.cartItem.quantity);
  if (fullyBilledIds.length > 0) {
    const { error: deleteItemsError } = await adminClient.from("cart_items").delete().in("id", fullyBilledIds);
    if (deleteItemsError) return json({ error: deleteItemsError.message }, 500);
  }
  for (const { cartItem, quantity } of partiallyBilled) {
    const { error: updateItemError } = await adminClient
      .from("cart_items")
      .update({ quantity: cartItem.quantity - quantity })
      .eq("id", cartItem.id);
    if (updateItemError) return json({ error: updateItemError.message }, 500);
  }

  const { count: remaining, error: remainingError } = await adminClient
    .from("cart_items")
    .select("id", { count: "exact", head: true })
    .eq("cart_id", cart.id);
  if (remainingError) return json({ error: remainingError.message }, 500);

  // Solo se marca convertido/cerrado cuando ya no queda nada por cobrar --
  // mientras haya ítems pendientes, la cuenta sigue abierta y visible en
  // el POS para el próximo cobro parcial. Con `keep_cart_open` no se cierra
  // nunca acá: cobrar no es cerrar la mesa (ver comentario de cabecera).
  if (!body.keep_cart_open && (!remaining || remaining === 0)) {
    const { error: cartUpdateError } = await adminClient.from("carts").update({ status: "converted", converted_order_id: orderId }).eq("id", cart.id);
    if (cartUpdateError) return json({ error: cartUpdateError.message }, 500);
  } else {
    const { error: cartTouchError } = await adminClient.from("carts").update({ last_activity_at: new Date().toISOString() }).eq("id", cart.id);
    if (cartTouchError) return json({ error: cartTouchError.message }, 500);
  }

  const { data: order, error: reloadError } = await adminClient.from("sales_orders").select("*").eq("id", orderId).single();
  if (reloadError) return json({ error: reloadError.message }, 500);
  return json(order);
});
