import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { computeLineTax, isTenantTaxEnabled } from "../invoicing/queueInvoiceGeneration.ts";

/** ÚNICA implementación de "reemplazar los ítems de un pedido y recalcular
 * sus totales" -- usada por whatsapp-ai-tools (create_quote/add_item_to_quote),
 * storefront (checkout) y el Edge Function sales-order-items (botón
 * "Guardar" del portal). Antes cada uno de los cuatro tenía su propia copia
 * casi idéntica de este cálculo -- encontrado en vivo 2026-09-03: el
 * portal sumaba el impuesto al total en vez de extraerlo del precio (doble
 * cobro), un bug que solo existía ahí porque era la única copia
 * desalineada; nada garantizaba que las otras tres no se desalinearan
 * también con el tiempo. Pedido explícito del usuario: un solo lugar, sin
 * importar quién llama -- nunca más una segunda copia de este cálculo.
 *
 * Reemplaza TODOS los ítems del pedido (no hace merge/diff) -- el llamador
 * decide qué significa eso: un pedido nuevo, o agregar una línea a una
 * cotización existente (leer los ítems actuales + agregar el nuevo +
 * mandar la lista completa acá, no un insert parcial). */
export interface ResolvedOrderItem {
  product_id: string | null;
  variant_id?: string | null;
  warehouse_id?: string | null;
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
  /** Monto plano, no porcentaje -- ver CLAUDE.md. */
  discount_amount?: number;
  /** Snapshot del producto -- quien resuelve el producto (AI por nombre,
   * portal por selector, storefront por carrito) ya lo trae consigo; esta
   * función nunca vuelve a resolverlo por su cuenta. */
  tax_type_code?: string | null;
  tax_rate?: number;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  total: number;
  taxTotal: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function persistOrderItems(
  adminClient: SupabaseClient,
  tenantId: string,
  orderId: string,
  items: ResolvedOrderItem[],
  shipping: number,
): Promise<OrderTotals> {
  const taxEnabled = await isTenantTaxEnabled(adminClient, tenantId);

  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  const rows = items.map((item, index) => {
    const gross = item.quantity * item.unit_price;
    const discount = item.discount_amount ?? 0;
    const lineSubtotal = gross - discount;
    subtotal += gross;
    discountTotal += discount;
    const rate = taxEnabled ? (item.tax_rate ?? 0) : 0;
    const { taxAmount, taxableBase } = taxEnabled ? computeLineTax(lineSubtotal, rate) : { taxAmount: 0, taxableBase: 0 };
    taxTotal += taxAmount;
    return {
      tenant_id: tenantId,
      order_id: orderId,
      product_id: item.product_id || null,
      variant_id: item.variant_id || null,
      warehouse_id: item.warehouse_id || null,
      product_name: item.product_name,
      sku: item.sku || null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_amount: discount,
      subtotal: lineSubtotal,
      tax_type_code: taxEnabled ? (item.tax_type_code ?? null) : null,
      tax_rate: rate,
      tax_amount: taxAmount,
      taxable_base: taxableBase,
      display_order: index,
    };
  });

  const { error: deleteError } = await adminClient.from("sales_order_items").delete().eq("order_id", orderId);
  if (deleteError) throw new Error(deleteError.message);
  if (rows.length > 0) {
    const { error: insertError } = await adminClient.from("sales_order_items").insert(rows);
    if (insertError) throw new Error(insertError.message);
  }

  taxTotal = round2(taxTotal);
  const total = subtotal - discountTotal + shipping;
  const { error: updateError } = await adminClient
    .from("sales_orders")
    .update({ subtotal, discount_total: discountTotal, total, shipping, tax_total: taxTotal })
    .eq("id", orderId);
  if (updateError) throw new Error(updateError.message);

  return { subtotal, discountTotal, total, taxTotal };
}
