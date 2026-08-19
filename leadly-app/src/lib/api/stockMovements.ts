import { supabase } from '../supabaseClient'
import type { ProductStock, StockMovement, StockMovementType } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

export type ProductStockWithWarehouse = ProductStock & { warehouse: { id: string; name: string } }
export type StockMovementWithWarehouse = StockMovement & { warehouse: { id: string; name: string } }

const STOCK_ENTRY_TYPES: StockMovementType[] = ['entrada', 'ajuste_positivo', 'transferencia_entrada', 'liberacion_reserva', 'reversion_dano']

/** true if this movement type adds to the product's available quantity,
 * false if it subtracts from it -- used by the UI to pick a sign/icon
 * without duplicating the DB trigger's bucket logic. Movements that only
 * shift stock between buckets without changing what's available (reserva,
 * salida_despacho, entrega_despacho, ajuste_dano) read as subtracting from
 * "available" here, which matches how they actually affect quantity. */
export function isStockEntry(type: StockMovementType): boolean {
  return STOCK_ENTRY_TYPES.includes(type)
}

/** Translation key per movement_type -- keeps the 12 DB values (see
 * stock_movements_movement_type_check) in sync with a label everywhere the
 * UI shows a movement, not just the 4 offered in the manual-entry drawer. */
export const MOVEMENT_TYPE_KEY: Record<StockMovementType, TranslationKey> = {
  entrada: 'inventory.movementType.entrada',
  salida: 'inventory.movementType.salida',
  ajuste_positivo: 'inventory.movementType.ajuste_positivo',
  ajuste_negativo: 'inventory.movementType.ajuste_negativo',
  transferencia_salida: 'inventory.movementType.transferencia_salida',
  transferencia_entrada: 'inventory.movementType.transferencia_entrada',
  reserva: 'inventory.movementType.reserva',
  liberacion_reserva: 'inventory.movementType.liberacion_reserva',
  salida_despacho: 'inventory.movementType.salida_despacho',
  entrega_despacho: 'inventory.movementType.entrega_despacho',
  ajuste_dano: 'inventory.movementType.ajuste_dano',
  reversion_dano: 'inventory.movementType.reversion_dano',
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

export interface ProductStockTotal {
  available: number
  reserved: number
}

/** One query, summed client-side per product -- used by the products LIST
 * (Products.tsx) to show "available"/"low stock" at a glance without a
 * per-product round trip. `products` itself carries no stock counter
 * anymore (see types/domain.ts), so this is the only way the list can know
 * how much of a product exists across every warehouse. */
export async function listStockTotalsByTenant(tenantId: string): Promise<Map<string, ProductStockTotal>> {
  const { data, error } = await supabase.from('product_stock').select('product_id, quantity, reserved_quantity').eq('tenant_id', tenantId)
  if (error) throw error

  const totals = new Map<string, ProductStockTotal>()
  for (const row of data as { product_id: string; quantity: number; reserved_quantity: number }[]) {
    const existing = totals.get(row.product_id) ?? { available: 0, reserved: 0 }
    existing.available += row.quantity
    existing.reserved += row.reserved_quantity
    totals.set(row.product_id, existing)
  }
  return totals
}

/** Product ids that have stock (quantity > 0) in one specific warehouse --
 * used to prefilter the products list when the "bodega" filter is set (see
 * Products.tsx). A product with stock in other warehouses but not this one
 * is correctly excluded, unlike listStockTotalsByTenant's tenant-wide sum. */
export async function listProductIdsWithWarehouseStock(tenantId: string, warehouseId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('product_stock')
    .select('product_id')
    .eq('tenant_id', tenantId)
    .eq('warehouse_id', warehouseId)
    .gt('quantity', 0)
  if (error) throw error
  return Array.from(new Set((data as { product_id: string }[]).map((r) => r.product_id)))
}

export async function listMovementsForProduct(productId: string, limit = 20): Promise<StockMovementWithWarehouse[]> {
  const { data, error } = await supabase
    .from('stock_movements')
    .select('*, warehouse:warehouses(id, name)')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}

export interface StockMovementInput {
  tenant_id: string
  product_id: string
  warehouse_id: string
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
