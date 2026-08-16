import { supabase } from '../supabaseClient'
import type { ProductStock, StockMovement, StockMovementType } from '../../types/domain'

export type ProductStockWithWarehouse = ProductStock & { warehouse: { id: string; name: string } }
export type StockMovementWithWarehouse = StockMovement & { warehouse: { id: string; name: string } }

const STOCK_ENTRY_TYPES: StockMovementType[] = ['entrada', 'ajuste_positivo', 'transferencia_entrada']

/** true if this movement type adds to stock, false if it subtracts -- used
 * by the UI to pick a sign/icon without duplicating the DB trigger's logic. */
export function isStockEntry(type: StockMovementType): boolean {
  return STOCK_ENTRY_TYPES.includes(type)
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
