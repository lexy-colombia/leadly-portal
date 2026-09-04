import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Sums product_stock (per-warehouse quantity) per product id, tenant-scoped
 * -- usado hoy solo por el pre-chequeo de UX en OrderDetail.tsx
 * (findStockShortfalls) para mostrarle al agente el detalle de faltantes
 * ANTES de confirmar, con tiempo de reaccionar (ajustar cantidades, etc.).
 * El chequeo real que bloquea la confirmación vive en el trigger de DB
 * (guard_sales_order_confirmation, 20260903180000) -- ver nota grande en
 * confirmSalesOrder más abajo. */
export async function getStockTotals(adminClient: SupabaseClient, tenantId: string, productIds: string[]): Promise<Map<string, { available: number }>> {
  const totals = new Map<string, { available: number }>();
  if (productIds.length === 0) return totals;

  const { data } = await adminClient.from("product_stock").select("product_id, quantity").eq("tenant_id", tenantId).in("product_id", productIds);

  for (const row of (data ?? []) as { product_id: string; quantity: number }[]) {
    const existing = totals.get(row.product_id) ?? { available: 0 };
    existing.available += row.quantity;
    totals.set(row.product_id, existing);
  }
  return totals;
}

/** Same idea as getStockTotals but scoped to one specific variant. */
export async function getVariantStock(adminClient: SupabaseClient, tenantId: string, variantId: string): Promise<{ available: number }> {
  const { data } = await adminClient.from("product_stock").select("quantity").eq("tenant_id", tenantId).eq("variant_id", variantId);
  const totals = { available: 0 };
  for (const row of (data ?? []) as { quantity: number }[]) {
    totals.available += row.quantity;
  }
  return totals;
}

/** Sigue en uso fuera del flujo de confirmación: whatsapp-ai-tools la usa
 * para que la IA sugiera/confirme la dirección guardada del cliente ANTES
 * de intentar confirmar la venta (mejor conversación, no descubre recién
 * al fallar) y para save_contact_address (ver isPlaceholderAddressText
 * abajo). El chequeo que efectivamente BLOQUEA la confirmación si no hay
 * dirección real vive en el trigger de DB (guard_sales_order_confirmation),
 * no acá -- esto es solo para UX conversacional. */
export async function getDefaultAddress(
  adminClient: SupabaseClient,
  tenantId: string,
  contactId: string,
  kind: "is_billing" | "is_shipping",
): Promise<{ id: string } | null> {
  const { data, error } = await adminClient
    .from("contact_addresses")
    .select("id, line1")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq(kind, true)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  const real = (data ?? []).find((row: { id: string; line1: string | null }) => row.line1 && !isPlaceholderAddressText(row.line1));
  return real ? { id: real.id } : null;
}

/** Catches the exact failure mode found live 2026-08-25: instead of asking
 * the customer for their real address, the model called save_contact_address
 * with line1 "Dirección no registrada" just to satisfy confirmSalesOrder.
 * Usada por save_contact_address (whatsapp-ai-tools) para rechazar un
 * placeholder al guardarlo, y por getDefaultAddress arriba -- el mismo
 * patrón de texto que ahora también usa el trigger de DB, ver
 * guard_sales_order_confirmation en 20260903180000_sales_order_confirm_triggers.sql. */
export function isPlaceholderAddressText(value: string): boolean {
  return /no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n\/a|na\b/i.test(value);
}

export type ConfirmSalesOrderResult =
  | { blocked: true; reason: "billing_address_required" | "shipping_address_required" | "insufficient_stock"; detail?: string }
  | { blocked: false; order: { id: string; number: number } };

/** "Confirmar una venta" -- llamado por whatsapp-ai-tools' confirm_quote
 * (AI-driven) y por el checkout de la tienda pública (customer-driven).
 *
 * 2026-09-03: se sacó de ACÁ el chequeo de stock, la resolución/exigencia
 * de dirección, mover la oportunidad a "Ganado", y la reserva de la
 * factura DIAN -- vivían solo en este archivo TS, y se encontró en vivo
 * que el botón "Confirmar" del portal (Orders.tsx/OrderDetail.tsx,
 * updateOrderStatus) hace un UPDATE directo a sales_orders sin pasar por
 * acá, así que una venta confirmada a mano en el portal nunca corría nada
 * de esto. Pedido explícito del usuario: esa lógica no puede depender de
 * que cada caller se acuerde de invocarla -- ahora vive en dos triggers de
 * sales_orders (guard_sales_order_confirmation BEFORE UPDATE,
 * apply_sales_order_confirmed_effects AFTER UPDATE, migración
 * 20260903180000_sales_order_confirm_triggers.sql) que aplican sí o sí
 * sobre CUALQUIER UPDATE que ponga status='confirmada', sin importar qué
 * código lo dispare. Esta función ahora solo valida el estado de entrada y
 * hace el UPDATE -- el trigger BEFORE puede rechazar la transacción
 * (RAISE EXCEPTION), que acá se traduce de vuelta al mismo `blocked`
 * tipado que ya usaban los callers, para no romper la conversación natural
 * de la IA pidiendo la dirección que falta. */
export async function confirmSalesOrder(adminClient: SupabaseClient, tenantId: string, _contactId: string, orderId: string): Promise<ConfirmSalesOrderResult> {
  const { data: order, error: orderError } = await adminClient
    .from("sales_orders")
    .select("id, number, status")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("No se encontró el pedido.");
  if (order.status !== "cotizacion") throw new Error("Este pedido ya no está pendiente de confirmar.");

  const { error } = await adminClient.from("sales_orders").update({ status: "confirmada" }).eq("id", order.id);
  if (error) {
    const message = error.message ?? "";
    if (message.startsWith("BILLING_ADDRESS_REQUIRED")) return { blocked: true, reason: "billing_address_required" };
    if (message.startsWith("SHIPPING_ADDRESS_REQUIRED")) return { blocked: true, reason: "shipping_address_required" };
    if (message.startsWith("INSUFFICIENT_STOCK")) return { blocked: true, reason: "insufficient_stock", detail: message };
    throw new Error(message);
  }

  return { blocked: false, order: { id: order.id, number: order.number } };
}
