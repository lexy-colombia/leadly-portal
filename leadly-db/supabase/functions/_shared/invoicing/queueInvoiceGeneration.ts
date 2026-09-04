import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Fase 1 (cimientos) de facturación electrónica DIAN: reserva una fila en
 * sales_invoices si el tenant tiene una credencial activa de 'dian_directo'
 * (integration_providers), validando que el comprador tenga documento fiscal
 * completo -- la dirección de facturación ya está garantizada por
 * confirmSalesOrder (contact_addresses vía sales_orders.billing_address_id),
 * no se vuelve a pedir acá. Si falta el documento, la fila igual se crea
 * pero en 'blocked_missing_buyer_data' con el detalle de qué falta, para que
 * la pantalla "Facturas" se lo muestre al tenant en vez de fallar en
 * silencio. Generar/firmar/enviar el XML real (incluyendo el desglose de
 * impuestos/retenciones) es una fase posterior -- acá solo se arma el
 * snapshot con todo lo que esa fase va a necesitar, para no tener que volver
 * a tocar el esquema de la base de datos.
 *
 * NUNCA debe lanzar -- se llama best-effort desde confirmSalesOrder, misma
 * razón que el paso de mover la oportunidad a "Ganado": una falla acá no
 * puede deshacer ni bloquear una venta ya confirmada. Para el reintento
 * manual, que SÍ tiene que poder reportarle el error a quien apretó el
 * botón, está `createInvoiceAttempt` abajo. */
export async function queueInvoiceGeneration(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
): Promise<void> {
  try {
    // La mayoría de los tenants no factura electrónicamente: eso NO es una
    // falla, es el camino normal, así que se sale en silencio antes de
    // llamar a createInvoiceAttempt (que sí lanza si no hay credencial,
    // porque en el reintento manual quien apretó el botón necesita el
    // mensaje). Sin este chequeo, cada venta confirmada de un tenant sin
    // DIAN dejaría un console.error que parece un error real y no lo es.
    if (!(await hasActiveDianCredential(adminClient, tenantId))) return;
    await createInvoiceAttempt(adminClient, tenantId, orderId, 1);
  } catch (err) {
    console.error(`queueInvoiceGeneration failed for order ${orderId}`, err);
  }
}

async function hasActiveDianCredential(
  adminClient: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  const { data } = await adminClient
    .from("integration_credentials")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "dian_directo")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

export interface InvoiceAttemptResult {
  invoiceId: string;
  status: "pending" | "blocked_missing_buyer_data";
  statusDetail: string | null;
}

/** Crea UNA fila de sales_invoices para `orderId` con el número de intento
 * dado, armando los snapshots de comprador/vendedor y copiando los ítems.
 *
 * Los snapshots se rearman SIEMPRE desde los datos actuales (clients /
 * contact_addresses / tenants / tenant_dian_profile), nunca se copian del
 * intento anterior: el motivo más común para reintentar es justamente que se
 * corrigió lo que hizo fallar al anterior (documento del cliente incompleto,
 * resolución vencida, perfil DIAN a medias). Copiar el snapshot viejo haría
 * que el reintento fallara igual, por definición.
 *
 * A diferencia de `queueInvoiceGeneration`, esta SÍ lanza -- el reintento es
 * una acción manual y explícita, quien la disparó tiene que enterarse de por
 * qué no se pudo. */
export async function createInvoiceAttempt(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
  attemptNumber: number,
): Promise<InvoiceAttemptResult> {
  if (!(await hasActiveDianCredential(adminClient, tenantId))) {
    throw new Error(
      "El tenant no tiene una credencial activa de facturación DIAN.",
    );
  }
  const snap = await buildOrderSnapshot(adminClient, tenantId, orderId);

  const { data: invoice, error: invoiceError } = await adminClient
    .from("sales_invoices")
    .insert({
      tenant_id: tenantId,
      order_id: orderId,
      attempt_number: attemptNumber,
      status: snap.status,
      status_detail: snap.statusDetail,
      subtotal: snap.subtotal,
      tax_total: snap.taxTotal,
      total: snap.total,
      currency: snap.currency,
      buyer_snapshot: snap.buyerSnapshot,
      seller_snapshot: snap.sellerSnapshot,
    })
    .select("id")
    .single();
  if (invoiceError) throw new Error(invoiceError.message);

  await replaceInvoiceItems(adminClient, tenantId, invoice.id, snap.items);

  return {
    invoiceId: invoice.id,
    status: snap.status,
    statusDetail: snap.statusDetail,
  };
}

/** Vuelve a armar el snapshot de una factura YA existente a partir del
 * pedido tal como está ahora, y reemplaza sus ítems.
 *
 * Existe porque el pedido sigue siendo editable después de confirmarse: se
 * bloquea recién cuando la DIAN acepta/recibe la factura (`dianLocksOrder`
 * en OrderDetail.tsx). Sin esto, corregir un precio entre "confirmar" y
 * "enviar a la DIAN" transmitía los valores VIEJOS -- el snapshot se había
 * congelado al confirmar. Se llama justo antes de construir el XML, así lo
 * que se le manda a la DIAN es siempre lo que el usuario tiene en pantalla,
 * y a partir de ahí el pedido queda bloqueado, así que no pueden volver a
 * divergir. */
export async function refreshInvoiceSnapshot(
  adminClient: SupabaseClient,
  tenantId: string,
  invoiceId: string,
  orderId: string,
): Promise<void> {
  const snap = await buildOrderSnapshot(adminClient, tenantId, orderId);
  const { error } = await adminClient
    .from("sales_invoices")
    .update({
      subtotal: snap.subtotal,
      tax_total: snap.taxTotal,
      total: snap.total,
      currency: snap.currency,
      buyer_snapshot: snap.buyerSnapshot,
      seller_snapshot: snap.sellerSnapshot,
    })
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  await replaceInvoiceItems(adminClient, tenantId, invoiceId, snap.items);
}

async function replaceInvoiceItems(
  adminClient: SupabaseClient,
  tenantId: string,
  invoiceId: string,
  // deno-lint-ignore no-explicit-any
  orderItems: any[],
): Promise<void> {
  await adminClient.from("sales_invoice_items").delete().eq(
    "invoice_id",
    invoiceId,
  );
  if (orderItems.length === 0) return;
  await adminClient.from("sales_invoice_items").insert(
    orderItems.map((item) => ({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      order_item_id: item.id,
      product_name: item.product_name,
      sku: item.sku,
      quantity: item.quantity,
      unit_price: item.unit_price,
      subtotal: item.subtotal,
      tax_type_code: item.tax_type_code,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      taxable_base: item.taxable_base,
      display_order: item.display_order,
    })),
  );
}

/** Arma comprador/vendedor/ítems/totales desde el pedido tal como está en
 * este momento. Es la ÚNICA fuente de esos datos: la usan tanto el alta de
 * un intento como el refresco previo al envío, para que no existan dos
 * versiones de la misma lógica que se desalineen. */
async function buildOrderSnapshot(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
) {
  const { data: order } = await adminClient
    .from("sales_orders")
    .select(
      "subtotal, tax_total, total, currency, contact_id, billing_address_id",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (!order) throw new Error("El pedido de esta factura ya no existe.");

  // clients no tiene columna propia de fiscal_regime (solo
  // tenant_dian_profile la tiene, para el propio tenant) -- pedirla acá
  // rompía todo el select en PostgREST (columna inexistente = error de la
  // query completa), y como el error se descartaba silenciosamente el
  // cliente quedaba "no encontrado" para CUALQUIER venta con impuestos
  // activados, sin importar si sus datos estaban completos. Encontrado
  // recién probando el flujo end-to-end contra la base real -- no dejar
  // que un select con una columna inexistente falle en silencio otra vez.
  const { data: client, error: clientError } = await adminClient
    .from("clients")
    .select(
      "id, full_name, email, phone, document_number, dian_document_type_code, applies_withholding",
    )
    .eq("id", order.contact_id)
    .maybeSingle();
  if (clientError) throw new Error(clientError.message);

  const { data: address } = order.billing_address_id
    ? await adminClient.from("contact_addresses").select(
      "line1, line2, city, state_province, country, tax_id",
    ).eq("id", order.billing_address_id).maybeSingle()
    : { data: null };

  const missing: string[] = [];
  if (!client?.dian_document_type_code) {
    missing.push("tipo de documento del cliente");
  }
  if (!client?.document_number) missing.push("número de documento del cliente");

  const { data: tenant } = await adminClient
    .from("tenants")
    .select(
      "legal_name, document_type, document_number, country, state_province, billing_address",
    )
    .eq("id", tenantId)
    .maybeSingle();
  const { data: dianProfile } = await adminClient
    .from("tenant_dian_profile")
    .select(
      "fiscal_regime, is_self_withholding_agent, city, resolution_number, resolution_prefix, resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until, software_id",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const buyerSnapshot = {
    client_id: client?.id ?? null,
    document_type_code: client?.dian_document_type_code ?? null,
    document_number: client?.document_number ?? null,
    full_name: client?.full_name ?? null,
    email: client?.email ?? null,
    phone: client?.phone ?? null,
    applies_withholding: client?.applies_withholding ?? false,
    address: address ?? null,
  };
  const sellerSnapshot = {
    tenant_id: tenantId,
    legal_name: tenant?.legal_name ?? null,
    document_type: tenant?.document_type ?? null,
    document_number: tenant?.document_number ?? null,
    fiscal_regime: dianProfile?.fiscal_regime ?? null,
    is_self_withholding_agent: dianProfile?.is_self_withholding_agent ?? false,
    city: dianProfile?.city ?? null,
    billing_address: tenant?.billing_address ?? null,
    country: tenant?.country ?? null,
    state_province: tenant?.state_province ?? null,
    resolution: dianProfile
      ? {
        number: dianProfile.resolution_number,
        prefix: dianProfile.resolution_prefix,
        range_from: dianProfile.resolution_range_from,
        range_to: dianProfile.resolution_range_to,
        valid_from: dianProfile.resolution_valid_from,
        valid_until: dianProfile.resolution_valid_until,
      }
      : null,
    software_id: dianProfile?.software_id ?? null,
  };

  const status = missing.length > 0 ? "blocked_missing_buyer_data" : "pending";
  const statusDetail = missing.length > 0
    ? `Falta: ${missing.join(", ")}`
    : null;
  const { data: orderItems } = await adminClient
    .from("sales_order_items")
    .select(
      "id, product_name, sku, quantity, unit_price, subtotal, tax_type_code, tax_rate, tax_amount, taxable_base, display_order",
    )
    .eq("order_id", orderId)
    .order("display_order");

  return {
    status: status as "pending" | "blocked_missing_buyer_data",
    statusDetail,
    subtotal: order.subtotal,
    taxTotal: order.tax_total,
    total: order.total,
    currency: order.currency,
    buyerSnapshot,
    sellerSnapshot,
    items: orderItems ?? [],
  };
}

/** Resuelve si el tenant tiene impuestos activados (tenant_dian_profile.tax_enabled)
 * -- usado por whatsapp-ai-tools/storefront al armar cada sales_order_item,
 * antes de decidir si calculan tax_type_code/tax_rate/tax_amount/taxable_base
 * o dejan esas columnas en su default (0/null, comportamiento idéntico al de
 * antes de esta fase). false por defecto si el tenant nunca configuró nada. */
export async function isTenantTaxEnabled(
  adminClient: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  const { data } = await adminClient.from("tenant_dian_profile").select(
    "tax_enabled",
  ).eq("tenant_id", tenantId).maybeSingle();
  return data?.tax_enabled ?? false;
}

export interface ProductTaxInfo {
  tax_type_code: string | null;
  tax_rate: number;
}

/** Precio ya incluye el impuesto -- se extrae, no se suma. Ver comentario en
 * la migración 20260903101000_sales_order_items_tax_snapshot.sql.
 *
 * Redondeado a 2 decimales (2026-09-03, encontrado en vivo): sin esto
 * quedaba un número larguísimo tipo 2814.814814814815 guardado en
 * sales_order_items/sales_invoice_items y mostrado tal cual en la UI --
 * mismo redondeo que ahora usa lib/api/orders.ts::computeItemTax del lado
 * del frontend (duplicado a propósito, son dos proyectos TS separados que
 * no comparten módulos). */
export function computeLineTax(
  subtotal: number,
  taxRate: number,
): { taxAmount: number; taxableBase: number } {
  if (!taxRate) return { taxAmount: 0, taxableBase: round2(subtotal) };
  const taxAmount = round2(subtotal - subtotal / (1 + taxRate / 100));
  return { taxAmount, taxableBase: round2(subtotal - taxAmount) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
