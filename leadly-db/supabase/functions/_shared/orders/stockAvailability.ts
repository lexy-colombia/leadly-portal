import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Chequeo de stock real, compartido por calculate-order (arma el
 * carrito/cotización -- lo usa SOLO para resaltar qué líneas no cumplen,
 * nunca para rechazar el guardado de un borrador) y create-order/pos-checkout
 * (crean la venta real -- ahí SÍ se rechaza la creación entera si hay algo
 * en la lista que devuelve esto, ver sus propios comentarios). Nunca vive en
 * el frontend -- pedido explícito del usuario 2026-09-06, "no debo hacer
 * validaciones en front de nada en estos componentes de pos ni en orden".
 *
 * `warehouse_id` en un ítem escopea el chequeo a ESA bodega puntual (lo que
 * arma OrderItemsEditor, que elige bodega por línea -- así el cajero puede
 * resolver un faltante cambiando de bodega, no solo bajando la cantidad).
 * Sin `warehouse_id` (POS de venta rápida, que no tiene selector de bodega),
 * se suma el stock de TODAS las bodegas del tenant. */
export interface StockCheckItem {
  product_id?: string | null;
  variant_id?: string | null;
  warehouse_id?: string | null;
  product_name: string;
  quantity: number;
}

export interface StockShortfall {
  product_id: string;
  variant_id: string | null;
  warehouse_id: string | null;
  product_name: string;
  available: number;
  requested: number;
}

export async function findStockShortfalls(adminClient: SupabaseClient, tenantId: string, items: StockCheckItem[]): Promise<StockShortfall[]> {
  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id)));
  if (productIds.length === 0) return [];

  const { data: products, error: productsError } = await adminClient.from("products").select("id, track_inventory").eq("tenant_id", tenantId).in("id", productIds);
  if (productsError) throw new Error(productsError.message);
  const trackedIds = new Set((products ?? []).filter((p) => p.track_inventory).map((p) => p.id as string));
  if (trackedIds.size === 0) return [];

  const { data: stockRows, error: stockError } = await adminClient
    .from("product_stock")
    .select("product_id, variant_id, warehouse_id, quantity")
    .eq("tenant_id", tenantId)
    .in("product_id", Array.from(trackedIds));
  if (stockError) throw new Error(stockError.message);

  const totalByKey = new Map<string, number>();
  const byWarehouseKey = new Map<string, number>();
  for (const row of (stockRows ?? []) as { product_id: string; variant_id: string | null; warehouse_id: string; quantity: number }[]) {
    const totalKey = `${row.product_id}:${row.variant_id ?? ""}`;
    totalByKey.set(totalKey, (totalByKey.get(totalKey) ?? 0) + row.quantity);
    byWarehouseKey.set(`${totalKey}:${row.warehouse_id}`, (byWarehouseKey.get(`${totalKey}:${row.warehouse_id}`) ?? 0) + row.quantity);
  }

  // Suma por clave -- varias líneas del mismo producto+variante+bodega (o
  // sin bodega) se piden juntas antes de comparar contra el stock real.
  const requestedByKey = new Map<string, { quantity: number; item: StockCheckItem }>();
  for (const item of items) {
    if (!item.product_id || !trackedIds.has(item.product_id) || !(item.quantity > 0)) continue;
    const key = `${item.product_id}:${item.variant_id ?? ""}:${item.warehouse_id ?? ""}`;
    const existing = requestedByKey.get(key);
    requestedByKey.set(key, { quantity: (existing?.quantity ?? 0) + item.quantity, item });
  }

  const shortfalls: StockShortfall[] = [];
  for (const { quantity: requested, item } of requestedByKey.values()) {
    const totalKey = `${item.product_id}:${item.variant_id ?? ""}`;
    const available = item.warehouse_id ? (byWarehouseKey.get(`${totalKey}:${item.warehouse_id}`) ?? 0) : (totalByKey.get(totalKey) ?? 0);
    if (requested > available) {
      shortfalls.push({
        product_id: item.product_id as string,
        variant_id: item.variant_id ?? null,
        warehouse_id: item.warehouse_id ?? null,
        product_name: item.product_name,
        available,
        requested,
      });
    }
  }
  return shortfalls;
}
