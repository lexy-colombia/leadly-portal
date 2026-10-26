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

/** Una fila de la disponibilidad unificada (RPC `stock_availability_rows`,
 * migración 20261026120000): físico, reservado por OTROS carritos y
 * disponible por producto + variante + bodega. Es la ÚNICA fuente de
 * "disponible" del backend (reserva de stock): findStockShortfalls,
 * storefront, la IA y el DTO del frontend salen de acá o de las RPC
 * hermanas `get_stock_availability*`. */
export interface AvailabilityRow {
  product_id: string;
  variant_id: string | null;
  warehouse_id: string;
  physical: number;
  reserved: number;
  available: number;
}

const RPC_ROW_CAP = 1000; // tope de filas de PostgREST (db.max_rows)

/** Lee la disponibilidad de varios productos del tenant. `excludeCartId` deja
 * fuera las reservas de ESE carrito (la cuenta abierta propia). El tope de
 * 1000 filas de PostgREST se esquiva partiendo la lista de productos a la
 * mitad cuando una respuesta llega al tope (nunca se trunca en silencio). */
export async function loadAvailabilityRows(
  adminClient: SupabaseClient,
  tenantId: string,
  productIds: string[],
  excludeCartId: string | null = null,
): Promise<AvailabilityRow[]> {
  if (productIds.length === 0) return [];
  const { data, error } = await adminClient.rpc("stock_availability_rows", {
    p_tenant_id: tenantId,
    p_product_ids: productIds,
    p_exclude_cart_id: excludeCartId,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as AvailabilityRow[];
  if (rows.length >= RPC_ROW_CAP) {
    if (productIds.length === 1) throw new Error("Demasiadas filas de stock para un solo producto.");
    const mid = Math.ceil(productIds.length / 2);
    const [a, b] = await Promise.all([
      loadAvailabilityRows(adminClient, tenantId, productIds.slice(0, mid), excludeCartId),
      loadAvailabilityRows(adminClient, tenantId, productIds.slice(mid), excludeCartId),
    ]);
    return [...a, ...b];
  }
  return rows.map((r) => ({ ...r, physical: Number(r.physical), reserved: Number(r.reserved), available: Number(r.available) }));
}

/** Disponible por producto (todas las variantes y bodegas) y por variante,
 * con el mismo criterio que `stock_available` / `get_stock_availability_totals`:
 * max(0, suma de físico - suma de reservado). */
export function summarizeAvailability(rows: AvailabilityRow[]): { byProduct: Map<string, number>; byVariant: Map<string, number>; byProductNoVariant: Map<string, number> } {
  const phys = new Map<string, { p: number; r: number }>();
  const add = (map: Map<string, { p: number; r: number }>, key: string, row: AvailabilityRow) => {
    const cur = map.get(key) ?? { p: 0, r: 0 };
    cur.p += row.physical;
    cur.r += row.reserved;
    map.set(key, cur);
  };
  const variantAcc = new Map<string, { p: number; r: number }>();
  const noVariantAcc = new Map<string, { p: number; r: number }>();
  for (const row of rows) {
    add(phys, row.product_id, row);
    if (row.variant_id) add(variantAcc, row.variant_id, row);
    else add(noVariantAcc, row.product_id, row);
  }
  const fin = (m: Map<string, { p: number; r: number }>) => new Map([...m].map(([k, v]) => [k, Math.max(v.p - v.r, 0)]));
  return { byProduct: fin(phys), byVariant: fin(variantAcc), byProductNoVariant: fin(noVariantAcc) };
}

/** Disponible por variante y por producto SIN variante (variant_id null) para
 * una lista de productos del tenant, sin reservas propias excluidas. Lo usan
 * la tienda pública y la IA (que nunca tienen "carrito propio" que excluir). */
export async function loadAvailabilitySummary(adminClient: SupabaseClient, tenantId: string, productIds: string[], excludeCartId: string | null = null) {
  return summarizeAvailability(await loadAvailabilityRows(adminClient, tenantId, productIds, excludeCartId));
}

export interface FindStockShortfallsOptions {
  /** Carrito cuyas reservas NO cuentan (la cuenta abierta que se guarda o
   * se cobra: su propia reserva no puede bloquear su propia venta). */
  excludeCartId?: string | null;
}

export async function findStockShortfalls(
  adminClient: SupabaseClient,
  tenantId: string,
  items: StockCheckItem[],
  options: FindStockShortfallsOptions = {},
): Promise<StockShortfall[]> {
  const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => !!id)));
  if (productIds.length === 0) return [];

  // Las dos lecturas son independientes: se piden en paralelo (un viaje en
  // vez de dos en serie). La disponibilidad se pide para TODOS los productIds
  // y el filtro por track_inventory se aplica en memoria. Precedencia de
  // errores igual que antes: primero el de products, luego el de stock.
  const [{ data: products, error: productsError }, availability] = await Promise.all([
    adminClient.from("products").select("id, track_inventory").eq("tenant_id", tenantId).in("id", productIds),
    loadAvailabilityRows(adminClient, tenantId, productIds, options.excludeCartId ?? null).then(
      (rows) => ({ ok: true as const, rows }),
      (error) => ({ ok: false as const, error }),
    ),
  ]);
  if (productsError) throw new Error(productsError.message);
  const trackedIds = new Set((products ?? []).filter((p) => p.track_inventory).map((p) => p.id as string));
  if (trackedIds.size === 0) return [];
  if (!availability.ok) throw availability.error instanceof Error ? availability.error : new Error(String(availability.error));

  // Disponible = físico - reservado de otros, por total (línea sin bodega:
  // todas las bodegas) o por bodega puntual. Mismo cálculo que stock_available.
  const totalByKey = new Map<string, { p: number; r: number }>();
  const byWarehouseKey = new Map<string, { p: number; r: number }>();
  const acc = (map: Map<string, { p: number; r: number }>, key: string, row: AvailabilityRow) => {
    const cur = map.get(key) ?? { p: 0, r: 0 };
    cur.p += row.physical;
    cur.r += row.reserved;
    map.set(key, cur);
  };
  for (const row of availability.rows) {
    const totalKey = `${row.product_id}:${row.variant_id ?? ""}`;
    acc(totalByKey, totalKey, row);
    acc(byWarehouseKey, `${totalKey}:${row.warehouse_id}`, row);
  }
  const net = (v: { p: number; r: number } | undefined) => (v ? Math.max(v.p - v.r, 0) : 0);

  // Suma por clave -- varias líneas del mismo producto+variante+bodega (o
  // sin bodega) se piden juntas antes de comparar contra el disponible.
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
    const available = item.warehouse_id ? net(byWarehouseKey.get(`${totalKey}:${item.warehouse_id}`)) : net(totalByKey.get(totalKey));
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

/** SQLSTATE que lanza `sync_cart_reservations` / `save_cart_lines` cuando una
 * línea pide más de lo disponible (migración 20261026120000). */
export const STOCK_REJECTED_CODE = "LX422";

/** Si `error` (de supabase-js/PostgREST) es un rechazo de reserva LX422,
 * devuelve el mensaje y la lista de faltantes (DETAIL = arreglo JSON); si no,
 * null. Un DETAIL ilegible no rompe: el mensaje igual sirve. */
export function parseStockRejection(error: { code?: string; message?: string; details?: string | null } | null | undefined): { message: string; shortfalls: StockShortfall[] } | null {
  if (!error || error.code !== STOCK_REJECTED_CODE) return null;
  let shortfalls: StockShortfall[] = [];
  try {
    const parsed = JSON.parse(error.details ?? "[]");
    if (Array.isArray(parsed)) {
      shortfalls = parsed.map((s) => ({
        product_id: String(s.product_id),
        variant_id: s.variant_id ?? null,
        warehouse_id: s.warehouse_id ?? null,
        product_name: String(s.product_name ?? ""),
        available: Number(s.available),
        requested: Number(s.requested),
      }));
    }
  } catch {
    // DETAIL no es JSON: se devuelve solo el mensaje.
  }
  return { message: error.message ?? "Sin stock suficiente.", shortfalls };
}
