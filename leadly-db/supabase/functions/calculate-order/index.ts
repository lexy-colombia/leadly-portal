/** ÚNICA puerta de escritura para el "estado editable" de un pedido desde
 * el portal: cliente, oportunidad, notas, direcciones de envío/facturación,
 * envío, e ítems (con su impuesto/totales calculados) -- todo en una sola
 * llamada, que reemplaza a sales-order-items (que solo cubría ítems) y a
 * los updates sueltos que hacía OrderDetail.tsx por campo. Pedido explícito
 * del usuario 2026-09-03: un solo proceso -- agregar un producto, cambiar
 * una cantidad, cambiar la dirección, todo pasa por acá, y el portal la
 * llama con debounce (2s de inactividad) en vez de un guardado por cada
 * campo suelto.
 *
 * Deliberadamente AFUERA de este alcance:
 * - Pagos (sales_order_payments) -- es una transacción financiera con su
 *   propio flujo (PaymentDrawer, Wompi, crédito), no un campo editable del
 *   pedido en borrador. Decisión explícita del usuario.
 * - Confirmar el pedido (status -> 'confirmada') -- ya tiene su propia
 *   validación robusta a nivel de DB (triggers
 *   guard_sales_order_confirmation / apply_sales_order_confirmed_effects,
 *   20260903180000), que necesita los ítems YA guardados para poder
 *   chequear stock de verdad. Por eso un pedido nuevo SIEMPRE se crea en
 *   'cotizacion' acá, incluso si el agente eligió "Confirmada" en el
 *   formulario -- el frontend hace el flip de estado en un segundo paso
 *   (updateOrderStatus), después de que los ítems ya existen, para que el
 *   trigger de confirmación tenga algo real que validar. Crear directo
 *   como 'confirmada' en el mismo insert saltaba ese chequeo por completo
 *   (el trigger de UPDATE nunca corre en un INSERT, y en ese instante
 *   todavía no hay ítems para chequear igual).
 *
 * El impuesto de cada ítem se resuelve acá contra la tabla products real
 * (nunca confía en lo que el navegador tenga cargado) -- mismo criterio
 * que ya tenía sales-order-items.
 *
 * Auth: JWT del propio caller (mismo patrón que whatsapp-send-human) --
 * tenant_id sale de profiles.tenant_id del caller, nunca de lo que mande
 * el body. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
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
  order_id?: string | null;
  contact_id?: string;
  opportunity_id?: string | null;
  notes?: string | null;
  valid_until?: string | null;
  shipping_address_id?: string | null;
  billing_address_id?: string | null;
  shipping?: number;
  items?: RawItemInput[];
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

  let orderId = body.order_id ?? null;

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
  } else {
    if (!body.contact_id) return json({ error: "contact_id es requerido para crear un pedido." }, 400);
    // Siempre nace en 'cotizacion' -- ver comentario de cabecera sobre por
    // qué el flip a 'confirmada' es un segundo paso, nunca este insert.
    const { data: newOrder, error: insertError } = await adminClient
      .from("sales_orders")
      .insert({
        tenant_id: tenantId,
        contact_id: body.contact_id,
        opportunity_id: body.opportunity_id ?? null,
        notes: body.notes ?? null,
        valid_until: body.valid_until ?? null,
        shipping_address_id: body.shipping_address_id ?? null,
        billing_address_id: body.billing_address_id ?? null,
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
    orderId = newOrder.id;
  }

  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id)));
  const productTaxById = new Map<string, { tax_type_code: string | null; tax_rate: number }>();
  if (productIds.length > 0) {
    const { data: products, error: productsError } = await adminClient.from("products").select("id, tax_type_code, tax_rate").in("id", productIds);
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
    await persistOrderItems(adminClient, tenantId, orderId as string, resolvedItems, body.shipping ?? 0);
    const { data: updatedOrder, error: reloadError } = await adminClient.from("sales_orders").select("*").eq("id", orderId as string).single();
    if (reloadError) return json({ error: reloadError.message }, 500);
    return json(updatedOrder);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
