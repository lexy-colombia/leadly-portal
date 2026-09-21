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
 * `stock_shortfalls` (2026-09-06, pedido explícito del usuario, corrige un
 * primer intento equivocado del mismo día): TODA llamada (preview, editar un
 * pedido real, o armar un carrito -- portal y POS por igual) devuelve, junto
 * a lo que ya devolvía, la lista de líneas cuya cantidad pedida supera el
 * stock real disponible (por bodega puntual si la línea tiene warehouse_id,
 * sumado en todas las bodegas si no) -- ver `_shared/orders/stockAvailability.ts`.
 * (Actualizado 2026-09-20: en un carrito de POS -- carts.origin = 'pos' -- un
 * faltante SÍ rechaza el guardado con 409, ver la rama de carrito más abajo;
 * lo que sigue describe Órdenes del portal, preview y pedidos reales, que no
 * cambian.)
 * Nunca bloquea el guardado del carrito/borrador con esto: el frontend usa
 * esta lista solo para pintar esas líneas en rojo y deshabilitar "Cobrar"/
 * "Crear pedido" mientras exista alguna, forzando a que el cajero/agente la
 * arregle (borrar la línea o cambiar de bodega) ANTES de poder avanzar --
 * pero el borrador en sí se guarda tal cual se mandó, para que la línea
 * problemática siga visible y editable en vez de desaparecer sola. El
 * bloqueo real y duro (rechazar la creación de la venta, sin excepción) vive
 * en create-order/pos-checkout, nunca acá -- ver sus comentarios.
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
 * Guardado de carrito (2026-09-21): la respuesta suma `totals` (misma forma y
 * mismo cálculo que el de `preview`, con el envío guardado) para que el POS no
 * tenga que pedir un preview aparte de los mismos ítems; en el 409 de stock no
 * viaja. Un carrito existente se guarda con la función atómica `save_cart_lines`.
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
import { findStockShortfalls } from "../_shared/orders/stockAvailability.ts";
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

  // Medición por fase (ver `[timing]` al final). Las fases que corren en
  // paralelo (checks, stock) reportan SU PROPIA duración, así que se pueden
  // solapar entre sí: no suman `total`.
  const tStart = Date.now();
  const ms = { auth: 0, profile: 0, checks: 0, stock: 0, totals: 0, write: 0, total: 0 };
  const logTiming = (mode: "preview" | "save") => {
    ms.total = Date.now() - tStart;
    console.log(`[timing] ${JSON.stringify({ mode, ms })}`);
  };
  const isCartPath = !body.preview && !body.order_id;
  const requestedCartId = body.cart_id ?? null;

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  ms.auth = Date.now() - tStart;
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  // El carrito existente no depende del tenant: se lee en paralelo con el
  // perfil (RLS del caller, solo para el origin y el estado). Su resultado se
  // evalúa más abajo, en el mismo orden de precedencia de siempre.
  const tProfile = Date.now();
  const [{ data: profile }, existingCartRes] = await Promise.all([
    callerClient.from("profiles").select("tenant_id").eq("id", caller.id).maybeSingle(),
    isCartPath && requestedCartId ? callerClient.from("carts").select("id, status, origin").eq("id", requestedCartId).maybeSingle() : Promise.resolve(null),
  ]);
  ms.profile = Date.now() - tProfile;
  if (!profile?.tenant_id) return json({ error: "No se pudo resolver el tenant del usuario." }, 403);
  const tenantId = profile.tenant_id as string;
  const existingCart = existingCartRes?.data ?? null;

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
  // Las consultas de dueño son independientes: van en paralelo (mismos
  // selects, mismo .eq("tenant_id")). El resultado se evalúa en el orden de
  // la lista, así el 403 que se devuelve es el mismo que en la versión serial.
  const tChecks = Date.now();
  const ownershipPromise = Promise.all(
    ownershipChecks
      .filter((check) => !!check.id)
      .map(async (check) => {
        const { data: owned } = await adminClient.from(check.table).select("id").eq("id", check.id as string).eq("tenant_id", tenantId).maybeSingle();
        return { field: check.field, owned: !!owned };
      }),
  ).then((r) => {
    ms.checks = Date.now() - tChecks;
    return r;
  });

  // Chequeo de stock: lectura independiente de los checks de dueño, se lanza
  // a la vez (solo en preview y en el camino de carrito, y solo si ese camino
  // va a llegar hasta el chequeo: carrito abierto o carrito nuevo con
  // contact_id). Un error se captura acá y se relanza recién donde antes se
  // habría lanzado, para no dejar un rechazo sin manejar si un 403/404/409 se
  // devuelve antes.
  const stockItems = items.map((item) => ({ product_id: item.product_id, variant_id: item.variant_id, warehouse_id: item.warehouse_id, product_name: item.product_name, quantity: item.quantity }));
  const cartRejectedEarly = isCartPath && (requestedCartId ? !existingCart || existingCart.status !== "open" : !body.contact_id);
  const wantsStock = body.preview || (isCartPath && !cartRejectedEarly);
  const tStock = Date.now();
  const stockPromise: Promise<{ ok: true; value: Awaited<ReturnType<typeof findStockShortfalls>> } | { ok: false; error: unknown }> | null = wantsStock
    ? findStockShortfalls(adminClient, tenantId, stockItems).then(
        (value) => {
          ms.stock = Date.now() - tStock;
          return { ok: true as const, value };
        },
        (error) => {
          ms.stock = Date.now() - tStock;
          return { ok: false as const, error };
        },
      )
    : null;
  const takeStock = async () => {
    const r = await stockPromise!;
    if (!r.ok) throw r.error;
    return r.value;
  };

  // Totales (preview Y guardado de carrito): impuesto del tenant y productos
  // en paralelo con el chequeo de stock y los de dueño, sin viajes seriales
  // extra. Mismo criterio que el preview de siempre: el impuesto se resuelve
  // contra la tabla real acotada al propio tenant, nunca contra el body. El
  // resultado de productos se ignora si el tenant no tiene impuestos activos.
  const tTotals = Date.now();
  const totalsProductIds = wantsStock ? Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id))) : [];
  // Las promesas se capturan a resultado ({ok}) para no dejar un rechazo sin
  // manejar si un 403/404/409 se devuelve antes de esperarlas.
  const taxPromise = wantsStock
    ? isTenantTaxEnabled(adminClient, tenantId).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      )
    : null;
  // El builder de PostgREST es perezoso (no dispara la request hasta su
  // await), así que se envuelve en una función async invocada YA: la consulta
  // arranca a la vez que las demás. Nunca rechaza (supabase-js devuelve
  // {data,error}); el .catch convierte cualquier excepción en un error de
  // resultado que se consume donde se consume el resultado normal.
  const productsTaxPromise =
    wantsStock && totalsProductIds.length > 0
      ? (async () => await adminClient.from("products").select("id, tax_type_code, tax_rate").eq("tenant_id", tenantId).in("id", totalsProductIds))().catch((e) => ({
          data: null,
          error: { message: e instanceof Error ? e.message : String(e) },
        }))
      : null;
  type TotalsPayload = {
    tax_enabled: boolean;
    subtotal: number;
    discount_total: number;
    taxable_base: number;
    tax_total: number;
    shipping: number;
    total: number;
    tax_lines: ReturnType<typeof computeOrderTotals>["taxLines"];
  };
  // Misma función y misma forma para preview y guardado (contrato con el
  // frontend: `totals` del guardado == `totals` del preview para los mismos
  // ítems y el mismo envío).
  const resolveTotals = async (shipping: number): Promise<{ ok: true; totals: TotalsPayload } | { ok: false; message: string }> => {
    const taxRes = await taxPromise!;
    if (!taxRes.ok) return { ok: false, message: taxRes.error instanceof Error ? taxRes.error.message : String(taxRes.error) };
    const taxEnabled = taxRes.value;
    const taxById = new Map<string, { tax_type_code: string | null; tax_rate: number }>();
    if (taxEnabled && productsTaxPromise) {
      const { data: products, error: productsError } = await productsTaxPromise;
      if (productsError) return { ok: false, message: productsError.message };
      for (const p of products ?? []) taxById.set(p.id, { tax_type_code: p.tax_type_code, tax_rate: p.tax_rate });
    }
    const computed = computeOrderTotals(
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
      shipping,
      taxEnabled,
    );
    ms.totals = Date.now() - tTotals;
    return {
      ok: true,
      totals: {
        tax_enabled: taxEnabled,
        subtotal: computed.subtotal,
        discount_total: computed.discountTotal,
        taxable_base: computed.taxableBase,
        tax_total: computed.taxTotal,
        shipping: computed.shipping,
        total: computed.total,
        tax_lines: computed.taxLines,
      },
    };
  };

  for (const r of await ownershipPromise) {
    if (!r.owned) return json({ error: `${r.field} no pertenece a este tenant.` }, 403);
  }

  if (body.preview) {
    const totalsRes = await resolveTotals(body.shipping ?? 0);
    if (!totalsRes.ok) return json({ error: totalsRes.message }, 500);
    const shortfalls = await takeStock();
    logTiming("preview");
    return json({ totals: totalsRes.totals, stock_shortfalls: shortfalls });
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
    // Despachado o anulado: sin excepción para nadie, ni siquiera con el
    // permiso de abajo -- pedido explícito del usuario 2026-09-11.
    if (dispatchLocked || cancelledLocked) {
      return json({ error: "Este pedido ya no se puede modificar (despachado o anulado)." }, 409);
    }

    // El TITULAR (contact_id) tiene su PROPIO candado, más amplio que el
    // de ítems/precios de más abajo: se bloquea apenas el pedido deja de
    // ser cotización -- confirmada, con o sin factura -- no solo cuando la
    // DIAN ya lo validó. Ampliado 2026-09-11 (segunda ronda, pedido
    // explícito del usuario tras probarlo contra un pedido real
    // confirmado pero sin facturar todavía, que seguía bloqueado igual):
    // el permiso `sales.edit_invoiced_order` ahora cubre las dos
    // situaciones con el mismo criterio, ver la migración
    // 20260911193000. Cotización sigue 100% libre para cualquiera, sin
    // permiso -- nunca lo necesitó.
    const contactLocked = existingOrder.status !== "cotizacion";
    if (body.contact_id !== undefined && contactLocked) {
      const { data: canEditConfirmed } = await callerClient.rpc("has_permission", { p_action_key: "sales.edit_invoiced_order" });
      if (!canEditConfirmed) {
        return json({ error: "El cliente de este pedido ya no se puede cambiar (el pedido ya está confirmado) -- hace falta el permiso para editar pedidos confirmados." }, 409);
      }
      const { error: contactPatchError } = await adminClient.from("sales_orders").update({ contact_id: body.contact_id }).eq("id", orderId);
      if (contactPatchError) return json({ error: contactPatchError.message }, 500);
    }

    // Ítems/precios y el resto de la cabecera: candado SIN CAMBIOS
    // respecto a antes -- factura DIAN ya enviada/aceptada bloquea sin
    // excepción (desalinearía un documento fiscal ya transmitido); una
    // venta confirmada que todavía no se facturó sigue siendo 100%
    // editable para cualquiera, como siempre.
    //
    // ⚠️ Ampliado 2026-09-12 por un incidente real (Barriles, pedido
    // #28245): una venta CONFIRMADA ya no acepta cambios de ítems/precios/
    // envío por esta vía, esté facturada o no. Antes solo `dianLocked`
    // cortaba acá, así que con la factura rechazada un autoguardado del
    // detalle (que en un pedido confirmado solo existe para cambiar el
    // cliente) reescribió los ítems -- y en una carrera con su propia
    // recarga llegó a mandar la lista vacía: el pedido quedó en $0, sin
    // productos, con el pago de $79.000 y el stock ya descontados. Una
    // venta confirmada ya se cobró y ya movió inventario; corregir su
    // composición es una devolución/nota crédito, no reescribir la fila.
    if (dianLocked || existingOrder.status !== "cotizacion") {
      const { data: updatedOrder, error: reloadError } = await adminClient.from("sales_orders").select("*").eq("id", orderId).single();
      if (reloadError) return json({ error: reloadError.message }, 500);
      return json({ ...updatedOrder, stock_shortfalls: [] });
    }

    const headerPatch: Record<string, unknown> = {};
    // contact_id ya se resolvió arriba (candado propio) cuando estaba
    // bloqueado; en cotización (nunca bloqueado) se aplica acá igual que
    // siempre.
    if (body.contact_id !== undefined && !contactLocked) headerPatch.contact_id = body.contact_id;
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
      const shortfalls = await findStockShortfalls(
        adminClient,
        tenantId,
        resolvedItems.map((item) => ({ product_id: item.product_id, variant_id: item.variant_id, warehouse_id: item.warehouse_id, product_name: item.product_name, quantity: item.quantity })),
      );
      return json({ ...updatedOrder, stock_shortfalls: shortfalls });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // Sin order_id: esto opera sobre un CARRITO, nunca sobre sales_orders
  // (ver comentario de cabecera). Sin impuesto resuelto acá -- se calcula
  // una sola vez, en create-order, al convertir.
  let cartId = requestedCartId;

  // Discriminador POS: `carts.origin`. En un carrito existente sale de la fila
  // guardada (leída con el cliente del caller, RLS) -- nunca de lo que mande
  // el body en esta llamada, así un guardado no puede "cambiarse" de origen
  // para saltarse la regla. En un carrito nuevo es el origin con que se crea
  // (el POS lo crea con 'pos', ver PosOpenTabs). Órdenes del portal es
  // 'portal' y conserva el comportamiento de siempre. (La fila se leyó arriba,
  // en paralelo con el perfil.)
  let cartOrigin: string = body.origin ?? "portal";

  if (cartId) {
    if (!existingCart) return json({ error: "Carrito no encontrado." }, 404);
    if (existingCart.status !== "open") return json({ error: "Este carrito ya no está abierto." }, 409);
    cartOrigin = existingCart.origin as string;
  } else if (!body.contact_id) {
    return json({ error: "contact_id es requerido para crear un carrito." }, 400);
  }

  // Chequeo de stock -- ver el comentario de `stock_shortfalls` en la
  // cabecera del archivo. Se lanzó arriba en paralelo con los checks de
  // dueño, pero se evalúa ANTES de escribir nada (ni cabecera ni ítems)
  // porque en el carrito de POS un faltante rechaza el guardado completo: la
  // línea que pide más de lo disponible nunca llega a la base y el carrito
  // queda exactamente como estaba (este endpoint reemplaza todas las líneas,
  // así que rechazar el guardado entero es "no guardar esa línea").
  // Reversión de la decisión del 2026-09-06 solo para POS; en Órdenes del
  // portal (origin 'portal') sigue informando sin rechazar.
  const shortfalls = await takeStock();
  // Una línea de producto CON variantes que todavía no eligió variante
  // (variant_id null, así nace al agregarla desde el buscador del POS) no es
  // una petición de stock real: findStockShortfalls la compara contra la
  // clave sin variante y siempre da 0. Rechazarla dejaría imposible agregar
  // cualquier producto con variantes; sigue saliendo en `stock_shortfalls`
  // (roja) y create-order/pos-checkout la frenan al cobrar.
  let rejectable = shortfalls;
  if (cartOrigin === "pos" && shortfalls.some((s) => !s.variant_id)) {
    const noVariantIds = Array.from(new Set(shortfalls.filter((s) => !s.variant_id).map((s) => s.product_id)));
    const { data: variantProducts, error: variantProductsError } = await adminClient.from("products").select("id").eq("tenant_id", tenantId).eq("has_variants", true).in("id", noVariantIds);
    if (variantProductsError) return json({ error: variantProductsError.message }, 500);
    const pendingVariantIds = new Set((variantProducts ?? []).map((p) => p.id as string));
    rejectable = shortfalls.filter((s) => s.variant_id || !pendingVariantIds.has(s.product_id));
  }
  if (cartOrigin === "pos" && rejectable.length > 0) {
    const detail = rejectable.map((s) => `"${s.product_name}" (disponible ${s.available}, pedido ${s.requested})`).join(", ");
    // Se devuelve el carrito tal como quedó en el servidor para que el
    // frontend deje de mostrar la línea que no se guardó.
    let currentCart: unknown = null;
    if (cartId) {
      const { data } = await adminClient.from("carts").select("*, items:cart_items(*)").eq("id", cartId).eq("tenant_id", tenantId).maybeSingle();
      currentCart = data ?? null;
    }
    logTiming("save");
    return json({ error: `Sin stock suficiente para: ${detail}.`, stock_shortfalls: rejectable, cart: currentCart }, 409);
  }

  const tWrite = Date.now();
  const itemRows = (id?: string) =>
    items.map((item) => ({
      ...(id ? { cart_id: id } : {}),
      product_id: item.product_id || null,
      variant_id: item.variant_id || null,
      warehouse_id: item.warehouse_id || null,
      product_name: item.product_name,
      sku: item.sku || null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_amount: item.discount_amount ?? 0,
    }));

  let cartRow: Record<string, unknown>;
  let savedItems: unknown[] = [];

  if (cartId) {
    // UNA sola llamada atómica (migración save_cart_lines): valida que el
    // carrito sea del tenant y siga abierto, aplica SOLO las claves presentes
    // del patch, reemplaza las líneas y devuelve el carrito con `items`. Antes
    // eran tres viajes sin transacción (update + delete + insert) que dos
    // guardados solapados podían intercalar duplicando líneas.
    const patch: Record<string, unknown> = {};
    if (body.contact_id !== undefined) patch.contact_id = body.contact_id;
    if (body.opportunity_id !== undefined) patch.opportunity_id = body.opportunity_id;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.valid_until !== undefined) patch.valid_until = body.valid_until;
    if (body.shipping_address_id !== undefined) patch.shipping_address_id = body.shipping_address_id;
    if (body.billing_address_id !== undefined) patch.billing_address_id = body.billing_address_id;
    if (body.shipping !== undefined) patch.shipping = body.shipping;
    if (body.pos_point_id !== undefined) patch.pos_point_id = body.pos_point_id;
    if (body.label !== undefined) patch.label = body.label;
    const { data: saved, error: saveError } = await adminClient.rpc("save_cart_lines", {
      p_cart_id: cartId,
      p_tenant_id: tenantId,
      p_patch: patch,
      p_items: itemRows(),
    });
    if (saveError) {
      // SQLSTATE propios de la función: se traducen igual que las
      // validaciones previas (por si el carrito cambió entre la lectura y el guardado).
      if (saveError.code === "LX404") return json({ error: "Carrito no encontrado." }, 404);
      if (saveError.code === "LX409") return json({ error: "Este carrito ya no está abierto." }, 409);
      return json({ error: saveError.message }, 500);
    }
    const { items: rpcItems, ...rpcCart } = saved as Record<string, unknown> & { items?: unknown[] };
    cartRow = rpcCart;
    savedItems = rpcItems ?? [];
  } else {
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
      .select("*")
      .single();
    if (cartInsertError) return json({ error: cartInsertError.message }, 500);
    cartRow = newCart as Record<string, unknown>;
    cartId = cartRow.id as string;
    // Carrito recién creado: no tiene ítems que borrar, solo insertar.
    if (items.length > 0) {
      const { data: inserted, error: insertItemsError } = await adminClient.from("cart_items").insert(itemRows(cartId)).select();
      if (insertItemsError) return json({ error: insertItemsError.message }, 500);
      savedItems = (inserted ?? []) as unknown[];
    }
  }
  ms.write = Date.now() - tWrite;

  // `totals` (contrato con el POS): mismo cálculo que el preview, con el
  // envío que quedó GUARDADO en el carrito (si el body no lo mandó, es el
  // que ya tenía). Es opcional: si falla la resolución del impuesto el
  // guardado ya hecho no se pierde y el frontend cae al preview.
  const totalsRes = await resolveTotals(Number(cartRow.shipping ?? 0));
  if (!totalsRes.ok) console.error(`[calculate-order] totals omitidos: ${totalsRes.message}`);

  logTiming("save");
  return json({ cart: { ...cartRow, items: savedItems }, stock_shortfalls: shortfalls, ...(totalsRes.ok ? { totals: totalsRes.totals } : {}) });
});
