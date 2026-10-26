import { supabase } from '../supabaseClient'
import type { ProductStock, StockMovement, StockMovementType } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

export type ProductStockWithWarehouse = ProductStock & { warehouse: { id: string; name: string } }
export type StockMovementWithWarehouse = StockMovement & { warehouse: { id: string; name: string } }

const STOCK_ENTRY_TYPES: StockMovementType[] = ['entrada', 'ajuste_positivo', 'transferencia_entrada', 'reversion_dano', 'entrada_devolucion']

/** true if this movement type adds to the product's available quantity,
 * false if it subtracts from it -- used by the UI to pick a sign/icon
 * without duplicating the DB trigger's bucket logic. Movements that only
 * shift stock between buckets without changing what's available
 * (ajuste_dano) read as subtracting from "available" here, which matches
 * how they actually affect quantity. reserva/liberacion_reserva/
 * salida_despacho/entrega_despacho removed 2026-08-25 along with the rest
 * of the despacho stock-effect logic -- only a venta confirmada touches
 * stock now (see 20260825134917_simplify_stock_effects_venta_only.sql /
 * 20260825142125_remove_dispatch_stock_movement_types.sql). */
export function isStockEntry(type: StockMovementType): boolean {
  return STOCK_ENTRY_TYPES.includes(type)
}

/** Translation key per movement_type -- keeps the DB values (see
 * stock_movements_movement_type_check) in sync with a label everywhere the
 * UI shows a movement, not just the 4 offered in the manual-entry drawer. */
export const MOVEMENT_TYPE_KEY: Record<StockMovementType, TranslationKey> = {
  entrada: 'inventory.movementType.entrada',
  salida: 'inventory.movementType.salida',
  ajuste_positivo: 'inventory.movementType.ajuste_positivo',
  ajuste_negativo: 'inventory.movementType.ajuste_negativo',
  transferencia_salida: 'inventory.movementType.transferencia_salida',
  transferencia_entrada: 'inventory.movementType.transferencia_entrada',
  ajuste_dano: 'inventory.movementType.ajuste_dano',
  reversion_dano: 'inventory.movementType.reversion_dano',
  entrada_devolucion: 'inventory.movementType.entrada_devolucion',
  devolucion_danada: 'inventory.movementType.devolucion_danada',
}

export async function listStockByProduct(productId: string): Promise<ProductStockWithWarehouse[]> {
  const { data, error } = await supabase
    .from('product_stock')
    .select('*, warehouse:warehouses(id, name)')
    .eq('product_id', productId)
    .order('quantity', { ascending: false })
  if (error) throw error
  return data
}

/** Totales de disponibilidad de UN producto o variante tal como los devuelve
 * el backend (RPC `get_stock_availability_totals`): `available` es EL número
 * a mostrar (físico menos lo reservado por OTROS carritos, nunca negativo);
 * `physical` solo sirve para pantallas de AJUSTE de inventario (QuickStock),
 * nunca para decidir si se puede vender. Nada se calcula acá. */
export interface ProductStockTotal {
  available: number
  physical: number
  reserved: number
}

export interface StockTotalsResult {
  byProduct: Map<string, ProductStockTotal>
  byVariant: Map<string, ProductStockTotal>
}

/** Fila del DTO `get_stock_availability` (por producto/variante/bodega). */
export interface ProductWarehouseAvailabilityRow {
  product_id: string
  variant_id: string | null
  warehouse_id: string
  physical: number
  reserved: number
  available: number
}

// La RPC trae una fila por producto + una por variante y PostgREST corta cada
// respuesta en 1000 filas: se pide por tandas de ids Y cada tanda se pagina
// con .range() (la RPC tiene orden estable: product_id, variant_id nulls
// first, scope), así nunca se trunca en silencio aunque haya muchas variantes.
const TOTALS_CHUNK = 50
const TOTALS_PAGE = 1000

/** Disponibilidad total (todas las bodegas) de estos productos, desde el
 * backend. Un producto sin control de inventario NO aparece (= sin límite);
 * un producto CON control que falte en el resultado es "desconocido" para el
 * llamador (nunca 0).
 * `excludeCartId`: la cuenta abierta propia, para que su reserva no cuente en
 * contra de sí misma. Lanza si el backend falla (el llamador trata eso como
 * "desconocido", no como cero). */
export async function listStockTotals(productIds: string[], excludeCartId?: string | null): Promise<StockTotalsResult> {
  const result: StockTotalsResult = { byProduct: new Map(), byVariant: new Map() }
  const ids = Array.from(new Set(productIds))
  for (let i = 0; i < ids.length; i += TOTALS_CHUNK) {
    const chunk = ids.slice(i, i + TOTALS_CHUNK)
    for (let from = 0; ; from += TOTALS_PAGE) {
      const { data, error } = await supabase
        .rpc('get_stock_availability_totals', { p_product_ids: chunk, p_exclude_cart_id: excludeCartId ?? null })
        .range(from, from + TOTALS_PAGE - 1)
      if (error) throw error
      const page = (data ?? []) as { product_id: string; variant_id: string | null; scope: 'product' | 'variant'; physical: number; reserved: number; available: number }[]
      for (const row of page) {
        const total = { available: Number(row.available), physical: Number(row.physical), reserved: Number(row.reserved) }
        if (row.scope === 'variant' && row.variant_id) result.byVariant.set(row.variant_id, total)
        else if (row.scope === 'product') result.byProduct.set(row.product_id, total)
      }
      if (page.length < TOTALS_PAGE) break
    }
  }
  return result
}

/** Disponibilidad por variante de UN producto (tarjetas de variantes y
 * selectores de variante) -- mismo origen que `listStockTotals`. */
export async function listStockTotalsByVariant(productId: string, excludeCartId?: string | null): Promise<Map<string, ProductStockTotal>> {
  return (await listStockTotals([productId], excludeCartId)).byVariant
}

/** Grilla completa de disponibilidad por (producto, variante, bodega), desde
 * el backend, ya con orden estable en la RPC: se pagina con `.range()` hasta
 * traer todo (tope de 1000 de PostgREST). `productIds` = null trae todo el
 * tenant (el tenant sale de la sesión, no de un parámetro). Un producto sin
 * control de inventario no aparece. */
export async function listAvailabilityByWarehouse(options: { productIds?: string[] | null; excludeCartId?: string | null } = {}): Promise<ProductWarehouseAvailabilityRow[]> {
  const { productIds = null, excludeCartId = null } = options
  if (productIds && productIds.length === 0) return []
  const pageSize = 1000
  const rows: ProductWarehouseAvailabilityRow[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .rpc('get_stock_availability', { p_product_ids: productIds, p_exclude_cart_id: excludeCartId })
      .range(from, from + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as ProductWarehouseAvailabilityRow[]
    rows.push(...page.map((r) => ({ ...r, physical: Number(r.physical), reserved: Number(r.reserved), available: Number(r.available) })))
    if (page.length < pageSize) break
  }
  return rows
}

/** Product ids con disponible > 0 en una bodega concreta (filtro "bodega" del
 * listado de productos) -- sale de la disponibilidad del backend. */
export async function listProductIdsWithWarehouseStock(warehouseId: string): Promise<string[]> {
  const rows = await listAvailabilityByWarehouse()
  return Array.from(new Set(rows.filter((r) => r.warehouse_id === warehouseId && r.available > 0).map((r) => r.product_id)))
}

export interface ProductWarehouseStockRow {
  product_id: string
  variant_id: string | null
  warehouse_id: string
  quantity: number
}

/** Grilla FÍSICA (product_stock) por producto/variante/bodega. Solo para
 * pantallas de AJUSTE de inventario (QuickStockPopover de Products.tsx, que
 * registra la diferencia contra el físico). NUNCA para decidir disponibilidad
 * de venta: eso sale de `listAvailabilityByWarehouse` (reservas incluidas). */
export async function listStockByWarehouse(tenantId: string): Promise<ProductWarehouseStockRow[]> {
  // PostgREST corta cada respuesta en `max_rows` (1000): un tenant con más
  // filas de product_stock (variantes x bodegas) recibiría la lista truncada y
  // los productos que quedan fuera aparecerían con disponible 0. Se pagina con
  // .range() -- con orden estable, si no las páginas pueden repetir/saltar
  // filas -- hasta traer todo. Misma firma y mismo resultado que antes.
  const pageSize = 1000
  const rows: ProductWarehouseStockRow[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('product_stock')
      .select('product_id, variant_id, warehouse_id, quantity')
      .eq('tenant_id', tenantId)
      .order('product_id')
      .order('warehouse_id')
      .order('variant_id', { nullsFirst: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}

/** Read complete history in bounded requests; pair transfers before UI pagination. */
export async function listMovementsForProduct(productId: string): Promise<StockMovementWithWarehouse[]> {
  const pageSize = 500
  const rows: StockMovementWithWarehouse[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('*, warehouse:warehouses(id, name)')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}

export interface StockMovementInput {
  tenant_id: string
  product_id: string
  warehouse_id: string
  variant_id?: string | null
  movement_type: StockMovementType
  quantity: number
  reference_type?: 'ajuste_manual'
  notes?: string | null
}

export async function recordStockMovement(input: StockMovementInput): Promise<StockMovement> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('stock_movements')
    .insert({ ...input, reference_type: input.reference_type ?? 'ajuste_manual', created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}

export interface StockTransferInput {
  tenant_id: string
  product_id: string
  from_warehouse_id: string
  to_warehouse_id: string
  variant_id?: string | null
  quantity: number
  notes?: string | null
}

/** Moves stock from one warehouse to another -- calls the `transfer_stock`
 * DB function (not two separate inserts) so both sides of the move (the
 * salida at origin, the entrada at destination) either both apply or
 * neither does, and can't be split by a failure between them. The function
 * itself also rejects moving more than what's actually available at the
 * origin. Returns the shared reference_id both resulting stock_movements
 * rows carry (reference_type='transferencia') -- combineTransferHistory
 * uses it to show the pair as one entry instead of two. */
export async function transferStock(input: StockTransferInput): Promise<string> {
  const { data, error } = await supabase.rpc('transfer_stock', {
    p_tenant_id: input.tenant_id,
    p_product_id: input.product_id,
    p_from_warehouse_id: input.from_warehouse_id,
    p_to_warehouse_id: input.to_warehouse_id,
    p_quantity: input.quantity,
    p_notes: input.notes ?? null,
    p_variant_id: input.variant_id ?? null,
  })
  if (error) throw error
  return data as string
}

export type MovementHistoryEntry =
  | { kind: 'movement'; movement: StockMovementWithWarehouse }
  | { kind: 'transfer'; id: string; from: StockMovementWithWarehouse; to: StockMovementWithWarehouse; created_at: string }

/** Pairs up transferencia_salida/transferencia_entrada rows that share a
 * reference_id (see transferStock) into one `transfer` entry, so the
 * history reads as "10 unidades: Bodega A → Bodega B" instead of two
 * unrelated-looking salida/entrada lines. A transfer row that somehow has
 * no matching counterpart (shouldn't happen given transfer_stock's
 * atomicity, but a raw/legacy row is possible) falls back to rendering on
 * its own like any other movement, instead of silently disappearing. */
export function combineTransferHistory(movements: StockMovementWithWarehouse[]): MovementHistoryEntry[] {
  const byReference = new Map<string, StockMovementWithWarehouse[]>()
  const entries: MovementHistoryEntry[] = []

  for (const movement of movements) {
    if (movement.reference_type === 'transferencia' && movement.reference_id) {
      const group = byReference.get(movement.reference_id) ?? []
      group.push(movement)
      byReference.set(movement.reference_id, group)
    } else {
      entries.push({ kind: 'movement', movement })
    }
  }

  for (const [referenceId, group] of byReference) {
    const from = group.find((m) => m.movement_type === 'transferencia_salida')
    const to = group.find((m) => m.movement_type === 'transferencia_entrada')
    if (from && to) {
      entries.push({ kind: 'transfer', id: referenceId, from, to, created_at: from.created_at })
    } else {
      group.forEach((movement) => entries.push({ kind: 'movement', movement }))
    }
  }

  entries.sort((a, b) => {
    const dateA = a.kind === 'movement' ? a.movement.created_at : a.created_at
    const dateB = b.kind === 'movement' ? b.movement.created_at : b.created_at
    return dateB.localeCompare(dateA)
  })
  return entries
}
