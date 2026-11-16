import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { buildFiscalBuyer, loadBillingProfileForOrder } from "./clientBillingProfile.ts";
import { resolveCityName } from "./cityName.ts";
import { REQUIRE_DANE_FOR_DELIVERY } from "../orders/fulfillmentAndBilling.ts";
import { deliveryDivipolaCodes, evaluateInvoiceDelivery } from "./invoiceDelivery.ts";

/** Fase 1 (cimientos) de facturación electrónica DIAN: reserva una fila en
 * sales_invoices si el tenant tiene una credencial activa de 'dian_directo'
 * (integration_providers), validando que el comprador tenga documento fiscal
 * completo y tomando la dirección fiscal del perfil del cliente. Si falta el documento, la fila igual se crea
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

/** Parámetros del comprobante que NO viven en la ficha del cliente. */
export interface InvoiceBuyerOptions {
  /** Correo del comprobante: solo para Consumidor Final sin perfil (walk-in).
   * Se congela únicamente en el buyer_snapshot de ESA factura. */
  invoiceEmail?: string | null;
  /** Solo para pruebas: fuerza la regla "adquirente no-NIT + domicilio sin
   * municipio/departamento de entrega => bloqueada". Por defecto sigue la
   * constante REQUIRE_DANE_FOR_DELIVERY (fulfillmentAndBilling.ts). */
  requireDeliveryDivipola?: boolean;
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
  buyerOptions: InvoiceBuyerOptions = {},
): Promise<InvoiceAttemptResult> {
  if (!(await hasActiveDianCredential(adminClient, tenantId))) {
    throw new Error(
      "El tenant no tiene una credencial activa de facturación DIAN.",
    );
  }
  // Reintento de un walk-in: parte del correo que el cajero ya capturó para
  // esta venta en un intento anterior (solo si vino de invoice_email).
  const invoiceEmail = buyerOptions.invoiceEmail?.trim() || (await previousInvoiceEmail(adminClient, tenantId, orderId));
  const snap = await buildOrderSnapshot(adminClient, tenantId, orderId, { invoiceEmail, requireDeliveryDivipola: buyerOptions.requireDeliveryDivipola });

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
  buyerOptions: InvoiceBuyerOptions = {},
): Promise<void> {
  // Consumidor Final: el correo del comprobante puede haberse capturado en una
  // solicitud anterior de ESTA venta que falló después. Solo se reutiliza un
  // correo que vino de invoice_email (email_source), nunca uno de la ficha.
  const invoiceEmail = buyerOptions.invoiceEmail?.trim() || (await previousInvoiceEmail(adminClient, tenantId, orderId));
  const snap = await buildOrderSnapshot(adminClient, tenantId, orderId, { invoiceEmail, requireDeliveryDivipola: buyerOptions.requireDeliveryDivipola });
  if (snap.status === "blocked_missing_buyer_data") {
    await adminClient.from("sales_invoices").update({
      status: snap.status, status_detail: snap.statusDetail,
    }).eq("id", invoiceId).eq("tenant_id", tenantId).in("status", ["pending", "blocked_missing_buyer_data"]);
    throw new Error(snap.statusDetail ?? "Faltan datos fiscales del cliente.");
  }
  const { error } = await adminClient
    .from("sales_invoices")
    .update({
      status: "pending",
      status_detail: null,
      subtotal: snap.subtotal,
      tax_total: snap.taxTotal,
      total: snap.total,
      currency: snap.currency,
      buyer_snapshot: snap.buyerSnapshot,
      seller_snapshot: snap.sellerSnapshot,
    })
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId)
    .in("status", ["pending", "blocked_missing_buyer_data"]);
  if (error) throw new Error(error.message);
  await replaceInvoiceItems(adminClient, tenantId, invoiceId, snap.items);
}

/** Correo de comprobante capturado en un intento anterior de la MISMA venta
 * (buyer_snapshot.email_source = 'invoice_email'). Nunca el de una ficha ni el
 * de otra venta. */
export async function previousInvoiceEmail(adminClient: SupabaseClient, tenantId: string, orderId: string): Promise<string | null> {
  const { data } = await adminClient
    .from("sales_invoices")
    .select("buyer_snapshot")
    .eq("tenant_id", tenantId)
    .eq("order_id", orderId)
    .order("attempt_number", { ascending: false })
    .limit(10);
  for (const row of data ?? []) {
    const snap = row.buyer_snapshot as { email?: string | null; email_source?: string | null } | null;
    if (snap?.email_source === "invoice_email" && snap.email?.trim()) return snap.email.trim();
  }
  return null;
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
      reference_unit_price: item.reference_unit_price ?? null,
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
  buyerOptions: InvoiceBuyerOptions = {},
) {
  const { data: order } = await adminClient
    .from("sales_orders")
    .select(
      "subtotal, tax_total, total, currency, contact_id, billing_profile_id, fulfillment_method, shipping_snapshot",
    )
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!order) throw new Error("El pedido de esta factura ya no existe.");

  // El comprador sale del PERFIL DE FACTURACIÓN (el elegido en el pedido o el
  // predeterminado del cliente), autosuficiente: de `clients` solo se lee la
  // identidad no fiscal y el flag de Consumidor Final. Sin respaldo desde
  // clients (legal_name||full_name, email, phone, retención): si falta algo,
  // se bloquea con la lista. Ver clientBillingProfile.ts.
  const { data: client, error: clientError } = await adminClient
    .from("clients")
    .select("id, full_name, document_number, dian_document_type_code, is_walk_in")
    .eq("id", order.contact_id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (clientError) throw new Error(clientError.message);

  const { profile, chosenMissing } = await loadBillingProfileForOrder(adminClient, tenantId, order.contact_id, order.billing_profile_id ?? null, !!client?.is_walk_in);
  const { buyer: buyerSnapshot, missing } = buildFiscalBuyer({ client, profile, invoiceEmail: buyerOptions.invoiceEmail ?? null });
  if (chosenMissing) {
    // El pedido apunta a un perfil que ya no existe (o fue borrado): no se cae
    // al predeterminado en silencio.
    missing.splice(0, missing.length, "perfil de facturación elegido (ya no existe)");
  }
  const address = buyerSnapshot.address;
  if (address?.country === "CO" && address.city_code && address.state_code) {
    const [{ data: city, error: cityError }, { data: department, error: departmentError }] = await Promise.all([
      adminClient.from("cities").select("name").eq("code", address.city_code).eq("department_code", address.state_code).maybeSingle(),
      adminClient.from("departments").select("name").eq("code", address.state_code).maybeSingle(),
    ]);
    if (cityError || departmentError) throw new Error("No se pudo verificar la dirección fiscal.");
    if (!city || !department) missing.push("municipio y departamento compatibles");
    else {
      address.city = city.name;
      address.state_province = department.name;
    }
  }

  // Lugar de entrega (cac:Delivery, Res. DIAN 227/2025 num. 3.2/3.3 + Anexo
  // 1.9 FAM01-FAM14): se lee del shipping_snapshot CONGELADO del pedido (no de
  // la libreta viva) y se valida contra el catálogo DIVIPOLA igual que la
  // dirección fiscal. Se guarda en buyer_snapshot.delivery; ver invoiceDelivery.ts.
  const shipping = (order.shipping_snapshot ?? null) as Record<string, unknown> | null;
  let divipola: { cityName: string; departmentName: string } | null = null;
  const deliveryCodes = order.fulfillment_method === "delivery" ? deliveryDivipolaCodes(shipping) : null;
  if (deliveryCodes) {
    const [{ data: dCity, error: dCityError }, { data: dDepartment, error: dDepartmentError }] = await Promise.all([
      adminClient.from("cities").select("name").eq("code", deliveryCodes.cityCode).eq("department_code", deliveryCodes.stateCode).maybeSingle(),
      adminClient.from("departments").select("name").eq("code", deliveryCodes.stateCode).maybeSingle(),
    ]);
    if (dCityError || dDepartmentError) throw new Error("No se pudo verificar la dirección de entrega.");
    if (dCity && dDepartment) divipola = { cityName: dCity.name, departmentName: dDepartment.name };
  }
  const { delivery, missing: deliveryMissing } = evaluateInvoiceDelivery({
    fulfillmentMethod: order.fulfillment_method,
    shippingSnapshot: shipping,
    buyerDocumentTypeCode: buyerSnapshot.document_type_code,
    divipola,
    requireDane: buyerOptions.requireDeliveryDivipola ?? REQUIRE_DANE_FOR_DELIVERY,
  });
  // Si el comprador ni siquiera está identificado, su propio faltante ya
  // bloquea; no se suma ruido sobre el destino.
  if (buyerSnapshot.document_type_code) missing.push(...deliveryMissing);

  const { data: tenant } = await adminClient
    .from("tenants")
    .select(
      "legal_name, document_type, document_number, country, state_province, billing_address, contact_email, fiscal_regime, is_self_withholding_agent, city_code, state_code",
    )
    .eq("id", tenantId)
    .maybeSingle();
  const { data: dianProfile } = await adminClient
    .from("tenant_dian_profile")
    .select(
      "resolution_number, resolution_prefix, resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until, software_id",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const cityName = await resolveCityName(adminClient, tenant?.city_code);

  const sellerSnapshot = {
    tenant_id: tenantId,
    legal_name: tenant?.legal_name ?? null,
    document_type: tenant?.document_type ?? null,
    document_number: tenant?.document_number ?? null,
    fiscal_regime: tenant?.fiscal_regime ?? null,
    is_self_withholding_agent: tenant?.is_self_withholding_agent ?? false,
    city: cityName,
    city_code: tenant?.city_code ?? null,
    state_code: tenant?.state_code ?? null,
    billing_address: tenant?.billing_address ?? null,
    country: tenant?.country ?? null,
    state_province: tenant?.state_province ?? null,
    // cac:Contact/cbc:ElectronicMail del emisor (regla FAJ71, rechazo real
    // de producción 2026-09-10) -- correo de contacto real del tenant, ya
    // cargado y obligatorio en Configuración, nunca inventado. Ver
    // buildInvoiceXml.ts para el porqué exacto.
    contact_email: tenant?.contact_email ?? null,
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
  const { data: orderItems, error: orderItemsError } = await adminClient
    .from("sales_order_items")
    .select(
      "id, product_name, sku, quantity, unit_price, subtotal, tax_type_code, tax_rate, tax_amount, taxable_base, display_order, product_id",
    )
    .eq("order_id", orderId)
    .order("display_order");
  if (orderItemsError) throw new Error(orderItemsError.message);
  const productIds = [...new Set((orderItems ?? []).map((item) => item.product_id).filter(Boolean))];
  const referencePrices = new Map<string, number | null>();
  if (productIds.length > 0) {
    const { data: products, error: productsError } = await adminClient.from("products")
      .select("id, dian_reference_price").eq("tenant_id", tenantId).in("id", productIds);
    if (productsError) throw new Error(productsError.message);
    for (const product of products ?? []) referencePrices.set(product.id, product.dian_reference_price);
  }

  return {
    status: status as "pending" | "blocked_missing_buyer_data",
    statusDetail,
    subtotal: order.subtotal,
    taxTotal: order.tax_total,
    total: order.total,
    currency: order.currency,
    buyerSnapshot: { ...buyerSnapshot, delivery },
    sellerSnapshot,
    items: (orderItems ?? []).map((item) => ({
      ...item,
      reference_unit_price: referencePrices.get(item.product_id) ?? null,
    })),
  };
}

/** Resuelve si el tenant tiene impuestos activados (tenants.tax_enabled)
 * -- usado por whatsapp-ai-tools/storefront al armar cada sales_order_item,
 * antes de decidir si calculan tax_type_code/tax_rate/tax_amount/taxable_base
 * o dejan esas columnas en su default (0/null, comportamiento idéntico al de
 * antes de esta fase). false por defecto si el tenant nunca configuró nada. */
export async function isTenantTaxEnabled(
  adminClient: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  const { data } = await adminClient.from("tenants").select(
    "tax_enabled",
  ).eq("id", tenantId).maybeSingle();
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
