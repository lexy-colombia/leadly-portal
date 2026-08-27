import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Sums product_stock (per-warehouse quantity) per product id, tenant-scoped
 * -- same client-side aggregation leadly-app's own listStockTotalsByTenant
 * does (see lib/api/stockMovements.ts), since products carries no stock
 * counter of its own post-cutover. Empty id list short-circuits to an empty
 * map instead of an unnecessary round trip. */
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

/** Same idea as getStockTotals but scoped to one specific variant -- for a
 * product that has_variants, summing product_stock by product_id alone
 * (getStockTotals) mixes every color/talla's stock together, which is
 * meaningless for "is there enough of the one the customer actually
 * ordered" (see confirmSalesOrder's stock check). */
export async function getVariantStock(adminClient: SupabaseClient, tenantId: string, variantId: string): Promise<{ available: number }> {
  const { data } = await adminClient.from("product_stock").select("quantity").eq("tenant_id", tenantId).eq("variant_id", variantId);
  const totals = { available: 0 };
  for (const row of (data ?? []) as { quantity: number }[]) {
    totals.available += row.quantity;
  }
  return totals;
}

/** Catches the exact failure mode found live 2026-08-25: instead of asking
 * the customer for their real address, the model called save_contact_address
 * with line1 "Dirección no registrada" just to satisfy confirmSalesOrder.
 * Not foolproof against a determined model, but combined with requiring
 * `city` on new addresses (see whatsapp-ai-tools::save_contact_address) and
 * the hard block below, it closes the specific hole that actually happened. */
export function isPlaceholderAddressText(value: string): boolean {
  return /no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n\/a|na\b/i.test(value);
}

/** Contact's own default address of the given kind (is_billing/is_shipping)
 * -- used to auto-apply an address the client already gave us on a previous
 * order instead of asking again, and as the hard gate in confirmSalesOrder
 * (see 2026-08-25 bug: the model invented a placeholder shipping address
 * instead of asking, because nothing actually required a real one to
 * exist). Skips placeholder-looking rows instead of just taking the first
 * match -- save_contact_address rejects new placeholders since that same
 * fix, but a contact who already had one saved before the fix would
 * otherwise keep satisfying this gate forever without ever being asked for
 * a real address again. */
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

export type ConfirmSalesOrderResult =
  | { blocked: true; reason: "billing_address_required" | "shipping_address_required" }
  | { blocked: false; order: { id: string; number: number } };

/** The core "confirm a sale" logic -- shared by whatsapp-ai-tools'
 * confirm_quote (AI-driven) and the public cart checkout page (customer-driven),
 * so both entry points enforce the exact same rules instead of a second copy
 * quietly drifting from the first. Given an order still in "cotizacion":
 * 1. Validates stock is actually available (variant-aware) -- throws if not,
 *    same as before this was extracted (a cotización never checks/holds
 *    stock, this is the one place that has to know fulfillment is possible).
 * 2. Requires a real billing AND shipping address already on the order or
 *    resolvable from the contact's saved defaults -- returns a `blocked`
 *    result (never throws) if either is missing, so the caller can go get
 *    it and retry, instead of confirming a sale that can't be billed or
 *    shipped.
 * 3. Flips the order to "confirmada" (the apply_sales_order_confirmed_stock_effect
 *    trigger does the real stock decrement off this UPDATE, see
 *    20260825134917_simplify_stock_effects_venta_only.sql -- this function
 *    only validates and updates, never touches product_stock directly).
 * 4. Best-effort moves the linked opportunity (if any) to its pipeline's
 *    "Ganado" stage -- a failure here shouldn't undo an already-confirmed
 *    sale.
 * Payment resolution (Wompi/crédito) is deliberately NOT done here -- the
 * AI path and the web-checkout path decide payment availability differently
 * (the AI additionally gates on ai_assistant_skills, the web page doesn't),
 * so each caller resolves payment itself right after calling this. */
export async function confirmSalesOrder(adminClient: SupabaseClient, tenantId: string, contactId: string, orderId: string): Promise<ConfirmSalesOrderResult> {
  const { data: order, error: orderError } = await adminClient
    .from("sales_orders")
    .select("id, number, status, billing_address_id, shipping_address_id, opportunity_id")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("No se encontró el pedido.");
  if (order.status !== "cotizacion") throw new Error("Este pedido ya no está pendiente de confirmar.");

  const { data: items } = await adminClient
    .from("sales_order_items")
    .select("product_name, quantity, product_id, variant_id")
    .eq("order_id", order.id)
    .not("product_id", "is", null);

  for (const item of items ?? []) {
    const { data: product } = await adminClient.from("products").select("track_inventory").eq("id", item.product_id).maybeSingle();
    if (!product?.track_inventory) continue;

    const totals = item.variant_id
      ? await getVariantStock(adminClient, tenantId, item.variant_id)
      : ((await getStockTotals(adminClient, tenantId, [item.product_id])).get(item.product_id) ?? { available: 0 });
    const available = totals.available;
    if (available < item.quantity) {
      throw new Error(`Stock insuficiente para confirmar "${item.product_name}": disponible ${Math.max(0, available)}, pedido ${item.quantity}.`);
    }
  }

  const orderUpdate: Record<string, string> = { status: "confirmada" };
  let billingAddressId = order.billing_address_id;
  if (!billingAddressId) {
    const billingAddress = await getDefaultAddress(adminClient, tenantId, contactId, "is_billing");
    if (!billingAddress) return { blocked: true, reason: "billing_address_required" };
    billingAddressId = billingAddress.id;
    orderUpdate.billing_address_id = billingAddressId;
  }
  let shippingAddressId = order.shipping_address_id;
  if (!shippingAddressId) {
    const shippingAddress = await getDefaultAddress(adminClient, tenantId, contactId, "is_shipping");
    if (!shippingAddress) return { blocked: true, reason: "shipping_address_required" };
    shippingAddressId = shippingAddress.id;
    orderUpdate.shipping_address_id = shippingAddressId;
  }

  const { error } = await adminClient.from("sales_orders").update(orderUpdate).eq("id", order.id);
  if (error) throw new Error(error.message);

  // Moving the linked opportunity (if any) to its pipeline's "Ganado" stage
  // used to happen in a DB trigger (trg_crm_orders_confirmed_opportunity,
  // 20260809170000) -- dropped 2026-08-17 along with the rest of crm_* (see
  // 20260817020001) and never rebuilt for the new schema, found live
  // 2026-08-24: 3 separate confirmed sales for the same contact all piled
  // onto the one opportunity that never left "Propuesta"
  // (resolveOrCreateOpportunityForQuote only reuses an OPEN one -- fix this
  // and the next quote for that contact starts a fresh opportunity
  // instead). Same is_won/is_lost -> status derivation as
  // update_opportunity_stage. Best-effort: a failure here shouldn't undo an
  // already-confirmed sale, same reasoning as
  // resolveOrCreateOpportunityForQuote's own try/catch.
  if (order.opportunity_id) {
    try {
      const { data: opportunity } = await adminClient.from("opportunities").select("pipeline_id").eq("id", order.opportunity_id).maybeSingle();
      if (opportunity) {
        const { data: wonStage } = await adminClient
          .from("pipeline_stages")
          .select("id")
          .eq("pipeline_id", opportunity.pipeline_id)
          .eq("is_won", true)
          .order("display_order", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (wonStage) {
          await adminClient.from("opportunities").update({ stage_id: wonStage.id, status: "won" }).eq("id", order.opportunity_id);
        }
      }
    } catch (err) {
      console.error(`Failed to move opportunity ${order.opportunity_id} to won after confirming order ${order.id}`, err);
    }
  }

  return { blocked: false, order: { id: order.id, number: order.number } };
}
