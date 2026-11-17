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
 * no ambigua de repartir un monto fijo entre unidades sueltas.
 *
 * `checkout_token` (opcional, 2026-09-06): mismo mecanismo de idempotencia
 * que pos-checkout -- bug real reportado en vivo, el botón "Guardar" del
 * pago de una cuenta abierta llama a `createOrder()` (esta función, con
 * `confirm: true`) recién dentro de PaymentDrawer; si ESE paso ya creó el
 * pedido pero el registro del pago que sigue falló (network, etc.), un
 * reintento del cajero volvía a llamar acá con el mismo carrito y creaba
 * OTRO pedido duplicado. Con el token, un reintento retoma la fila que ya
 * se insertó (y ya se confirmó, si sales_channel='pos' -- ver
 * guard_sales_order_confirmation) en vez de insertar otra.
 *
 * Chequeo de stock antes de crear (2026-09-06, corrige un bug real de
 * producción -- una venta se había creado sin que nadie validara que había
 * inventario): a diferencia de calculate-order (que solo informa
 * `stock_shortfalls`, sin bloquear el guardado del carrito), ACÁ el chequeo
 * es duro -- si alguna línea pide más de lo que hay en su bodega (o en
 * cualquier bodega, si la línea no tiene una puntual), se rechaza la
 * creación ENTERA antes de tocar la base: no se inserta `sales_orders`, no
 * se persisten ítems, no se mueve nada del carrito. El carrito queda
 * exactamente como estaba, abierto, para que se siga editando desde el
 * front (borrar la línea o cambiar de bodega) y se reintente cuando el
 * problema esté resuelto. Pedido explícito del usuario: "el endpoint de
 * crear orden siempre debe validar... si hay algo que no, rechaza la
 * creación y no crea cotizaciones". */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
import { findStockShortfalls } from "../_shared/orders/stockAvailability.ts";
import { BILLING_PROFILE_MISMATCH_CODE, BILLING_PROFILE_MISMATCH_MESSAGE, billingProfileMismatch, describeOrderLinkError, normalizeShippingDestination, REQUIRE_DANE_FOR_DELIVERY, resolveFulfillmentAndBilling, type FulfillmentMethod } from "../_shared/orders/fulfillmentAndBilling.ts";
import { corsHeaders } from "../_shared/cors.ts";

interface CreateOrderBody {
  cart_id?: string;
  items?: { id: string; quantity: number }[];
  keep_cart_open?: boolean;
  confirm?: boolean;
  checkout_token?: string | null;
  // Comprador de ESTA orden puntual, para facturación DIAN por división
  // (2026-09-08, POS "Dividir cuenta"): ausente = comportamiento de
  // siempre (contact_id: cart.contact_id); string = un cliente puntual
  // distinto al de la cuenta (validado contra el tenant del caller antes
  // de usarlo, nunca confiar en el id tal cual); null explícito = el
  // walk-in del tenant. Nunca se aplica sobre un pedido ya existente
  // (retry por checkout_token) -- el comprador de un pedido ya creado no
  // se puede cambiar después.
  //
  // @deprecated (feature perfiles de facturación): `buyer_contact_id` REEMPLAZA
  // `sales_orders.contact_id`, y de ese contact_id cuelgan los cargos de
  // crédito y el saldo a favor -- facturar "a otro" movía también la deuda.
  // Con perfiles ya no hace falta: el cliente de la venta (contact_id) no
  // cambia y "Facturar a" se expresa con `billing_profile_id`. Se mantiene
  // funcionando SOLO como compatibilidad hasta que el frontend (S5) deje de
  // enviarlo; no cambia el contact_id del pedido más de lo que ya hacía.
  buyer_contact_id?: string | null;
  // "Facturar a" de ESTA venta (cada parte de una cuenta dividida es su propio
  // pedido y su propia factura). undefined = el perfil guardado en la cuenta
  // (carrito), si es del mismo cliente; null = sin perfil elegido. Debe ser un
  // perfil vivo del cliente del pedido y del tenant. Solo se aplica al INSERT:
  // en un reintento por checkout_token el pedido existente no se reescribe.
  billing_profile_id?: string | null;
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
    .select("id, contact_id, opportunity_id, notes, valid_until, shipping_address_id, shipping_snapshot, billing_address_id, billing_profile_id, fulfillment_method, shipping, origin, status, pos_point_id, label")
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
    // Filtro de tenant explícito -- el admin client no tiene RLS, así que
    // sin esto un product_id de OTRO tenant (adivinado o filtrado) igual
    // resolvería su tax_type_code/tax_rate real.
    const { data: products, error: productsError } = await adminClient.from("products").select("id, tax_type_code, tax_rate").eq("tenant_id", tenantId).in("id", productIds);
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

  // Idempotencia (ver comentario de cabecera): un reintento con el mismo
  // checkout_token retoma el pedido que un intento anterior ya insertó (y
  // tal vez ya confirmó) en vez de crear otro.
  const checkoutToken = body.checkout_token || null;
  let orderId: string | null = null;
  let alreadyConfirmed = false;
  if (checkoutToken) {
    const { data: existingOrder, error: existingOrderError } = await adminClient
      .from("sales_orders")
      .select("id, status, billing_profile_id")
      .eq("tenant_id", tenantId)
      .eq("checkout_token", checkoutToken)
      .maybeSingle();
    if (existingOrderError) return json({ error: existingOrderError.message }, 500);
    if (existingOrder) {
      // Reintento de un cobro que ya creó el pedido: "Facturar a" quedó fijado
      // al INSERT y no se reescribe. Si el cajero lo cambió después de fallar el
      // cobro, la factura saldría al perfil ORIGINAL sin que lo sepa: se
      // rechaza con un código estable, sin tocar nada.
      if (billingProfileMismatch(body.billing_profile_id, existingOrder.billing_profile_id as string | null)) {
        return json({ error: BILLING_PROFILE_MISMATCH_MESSAGE, code: BILLING_PROFILE_MISMATCH_CODE }, 409);
      }
      orderId = existingOrder.id as string;
      alreadyConfirmed = existingOrder.status === "confirmada";
    }
  }

  // Comprador de esta orden puntual -- ver CreateOrderBody. Solo se resuelve
  // cuando de verdad se va a insertar una orden nueva (nunca sobre un
  // retry que ya encontró una existente por checkout_token).
  let resolvedContactId: string = cart.contact_id;
  if (!orderId && body.buyer_contact_id !== undefined) {
    if (body.buyer_contact_id === null) {
      const { data: walkIn } = await adminClient.from("clients").select("id").eq("tenant_id", tenantId).eq("is_walk_in", true).maybeSingle();
      if (!walkIn) return json({ error: "No se encontró el cliente de mostrador del tenant." }, 500);
      resolvedContactId = walkIn.id as string;
    } else {
      // callerClient (RLS) en vez de adminClient -- si el cliente es de otro
      // tenant, esto viene null igual que "no existe", nunca confiar en el
      // id sin comprobar dueño primero.
      const { data: buyer } = await callerClient.from("clients").select("id").eq("id", body.buyer_contact_id).maybeSingle();
      if (!buyer) return json({ error: "Cliente no encontrado." }, 404);
      resolvedContactId = buyer.id as string;
    }
  }

  // Campos de entrega/facturación del pedido nuevo (solo se calculan para un
  // INSERT; en un reintento por token la fila existente se retoma tal cual).
  // La dirección y el perfil del carrito pertenecen al cliente de la cuenta:
  // si el comprador cambió (buyer_contact_id, deprecado), no se copian.
  const sameContact = resolvedContactId === cart.contact_id;
  const orderFulfillment: FulfillmentMethod = cart.origin === "pos" ? "on_site" : (cart.fulfillment_method as FulfillmentMethod) ?? "delivery";
  const orderShippingAddressId: string | null = sameContact ? (cart.shipping_address_id ?? null) : null;
  const orderBillingProfileId: string | null = body.billing_profile_id !== undefined ? body.billing_profile_id : sameContact ? (cart.billing_profile_id ?? null) : null;
  let billingMissing: string[] = [];
  if (!orderId) {
    const links = await resolveFulfillmentAndBilling(adminClient, {
      tenantId,
      contactId: resolvedContactId,
      fulfillmentMethod: orderFulfillment,
      shippingAddressId: orderShippingAddressId,
      shippingDestination: orderShippingAddressId ? null : normalizeShippingDestination(cart.shipping_snapshot),
      billingProfileId: orderBillingProfileId,
      // Elegir un perfil = se va a facturar a ese perfil. Solo informativo:
      // un perfil incompleto NO bloquea la venta (la factura queda
      // bloqueada con la misma lista, ver billing_missing en la respuesta).
      invoiceRequested: !!orderBillingProfileId,
      requireDane: REQUIRE_DANE_FOR_DELIVERY,
      useDefaultDestination: !!body.confirm,
    });
    if (links.forbidden.length > 0) return json({ error: links.forbidden[0] }, 403);
    // Un envío sin destino se rechaza ANTES de insertar nada (el trigger de
    // confirmación lo rechazaría igual, pero dejaría una cotización huérfana).
    if (body.confirm && links.missingDestination.length > 0) {
      return json({ error: `Falta: ${links.missingDestination.join(", ")}.` }, 409);
    }
    billingMissing = links.missingBilling;
  }

  if (!orderId) {
    // Rechazo duro -- ver comentario de cabecera. Se corre ACÁ, antes de
    // cualquier insert, para que un stock insuficiente no deje ninguna
    // fila huérfana ni toque el carrito.
    const shortfalls = await findStockShortfalls(
      adminClient,
      tenantId,
      resolvedItems.map((item) => ({ product_id: item.product_id, variant_id: item.variant_id, warehouse_id: item.warehouse_id, product_name: item.product_name, quantity: item.quantity })),
      // Disponible = físico - reservas de OTRAS cuentas: la reserva de esta
      // misma cuenta es la que se está por consumir y no puede bloquearla.
      { excludeCartId: cart.id as string },
    );
    if (shortfalls.length > 0) {
      const detail = shortfalls.map((s) => `"${s.product_name}" (disponible ${s.available}, pedido ${s.requested})`).join(", ");
      return json({ error: `Sin stock suficiente para: ${detail}.` }, 409);
    }

    const { data: newOrder, error: insertError } = await adminClient
      .from("sales_orders")
      .insert({
        tenant_id: tenantId,
        cart_id: cart.id,
        contact_id: resolvedContactId,
        opportunity_id: cart.opportunity_id,
        notes: cart.notes,
        valid_until: cart.valid_until,
        shipping_address_id: orderShippingAddressId,
        // Destino de un solo uso del carrito (sin dirección de la libreta): se
        // copia al pedido tal cual al INSERT; el guard de confirmación lo respeta.
        shipping_snapshot: orderShippingAddressId ? null : (cart.shipping_snapshot ?? null),
        // @deprecated: la dirección de facturación fue reemplazada por el
        // perfil de facturación; se sigue copiando mientras quede código que
        // la lea (SQL de transición de apply_sales_order_confirmed_effects).
        billing_address_id: sameContact ? cart.billing_address_id : null,
        billing_profile_id: orderBillingProfileId,
        fulfillment_method: orderFulfillment,
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
        checkout_token: checkoutToken,
      })
      .select("id")
      .single();
    if (insertError) {
      const linkErr = describeOrderLinkError(insertError);
      return json({ error: linkErr?.message ?? insertError.message }, linkErr?.status ?? 500);
    }
    orderId = newOrder.id as string;

    try {
      await persistOrderItems(adminClient, tenantId, orderId, resolvedItems, cart.shipping ?? 0);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  const resolvedOrderId: string = orderId;

  // Confirmar antes de tocar el carrito: si el trigger rechaza (dirección,
  // o stock para un canal que no sea 'pos' -- ver
  // guard_sales_order_confirmation), la cuenta conserva todos sus
  // productos. El prefijo tipo "BILLING_ADDRESS_REQUIRED: " que agrega el
  // trigger se saca acá, igual que hace updateOrderStatus en el frontend --
  // el resto del texto ya es un mensaje claro en español.
  if (body.confirm && !alreadyConfirmed) {
    const { error: confirmError } = await adminClient.from("sales_orders").update({ status: "confirmada" }).eq("id", resolvedOrderId);
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
  // Una sola función atómica (migración 20261026130000): toma el lock del
  // carrito ANTES de tocar cart_items (mismo orden que save_cart_lines, así
  // un autosave de otra caja no se cruza en deadlock) y descuenta lo cobrado
  // de forma relativa.
  if (fullyBilledIds.length > 0 || partiallyBilled.length > 0) {
    const { error: settleError } = await adminClient.rpc("cart_settle_billed_items", {
      p_cart_id: cart.id,
      p_tenant_id: tenantId,
      p_full_ids: fullyBilledIds,
      p_partial: partiallyBilled.map(({ cartItem, quantity }) => ({ id: cartItem.id, qty: quantity })),
    });
    if (settleError) return json({ error: settleError.message }, 500);
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
    const { error: cartUpdateError } = await adminClient.from("carts").update({ status: "converted", converted_order_id: resolvedOrderId }).eq("id", cart.id);
    if (cartUpdateError) return json({ error: cartUpdateError.message }, 500);
  } else {
    const { error: cartTouchError } = await adminClient.from("carts").update({ last_activity_at: new Date().toISOString() }).eq("id", cart.id);
    if (cartTouchError) return json({ error: cartTouchError.message }, 500);
  }

  const { data: order, error: reloadError } = await adminClient.from("sales_orders").select("*").eq("id", resolvedOrderId).single();
  if (reloadError) return json({ error: reloadError.message }, 500);
  // `billing_missing`: faltantes del perfil elegido (misma lista que usa la
  // emisión). Informativo -- no bloquea la venta.
  return json({ ...order, billing_missing: billingMissing });
});
