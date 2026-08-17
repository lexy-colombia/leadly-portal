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
