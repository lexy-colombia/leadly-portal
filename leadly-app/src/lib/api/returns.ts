import { supabase } from '../supabaseClient'
import type { Return, ReturnItem, ReturnItemCondition, ReturnReason, ReturnStatusHistoryEntry, SalesOrderItem, StoreCreditGrant } from '../../types/domain'

export interface ReturnWithOrder extends Return {
  sales_order: { number: number; currency: string; contact: { full_name: string; phone_prefix: string; phone: string } | null } | null
  status: { name: string; color: string } | null
  resolution_type: { name: string; effect: string } | null
  // Ítems del ticket con el precio unitario de la línea original -- listReturns
  // los trae para que Returns.tsx pueda calcular el "saldo en reclamación"
  // (cantidad × precio) sin una consulta aparte por fila.
  items: { quantity: number; sales_order_item: { unit_price: number } | null }[]
}

const RETURN_SELECT =
  '*, sales_order:sales_orders(number, currency, contact:clients(full_name, phone_prefix, phone)), status:return_statuses(name, color), resolution_type:return_resolution_types(name, effect), items:return_items(quantity, sales_order_item:sales_order_items(unit_price))'

export async function listReturns(tenantId: string): Promise<ReturnWithOrder[]> {
  const { data, error } = await supabase.from('returns').select(RETURN_SELECT).eq('tenant_id', tenantId).order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as ReturnWithOrder[]
}

export async function listReturnsForOrder(salesOrderId: string): Promise<Return[]> {
  const { data, error } = await supabase.from('returns').select('*').eq('sales_order_id', salesOrderId).order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getReturn(id: string): Promise<ReturnWithOrder | null> {
  const { data, error } = await supabase.from('returns').select(RETURN_SELECT).eq('id', id).maybeSingle()
  if (error) throw error
  return data as unknown as ReturnWithOrder | null
}

export interface ReturnItemDraft {
  sales_order_item_id: string
  quantity: number
}

export interface ReturnCreateInput {
  tenant_id: string
  sales_order_id: string
  status_id: string
  reason: ReturnReason
  notes?: string | null
  items: ReturnItemDraft[]
}

/** Crea el ticket y sus ítems en dos pasos -- si el insert de ítems falla,
 * borra el ticket recién creado para no dejar un return sin ningún ítem
 * (mismo criterio que createPipeline en lib/api/pipelines.ts). */
export async function createReturn(input: ReturnCreateInput): Promise<Return> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { items, ...ticketInput } = input
  const { data: created, error } = await supabase
    .from('returns')
    .insert({ ...ticketInput, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error

  const { error: itemsError } = await supabase.from('return_items').insert(
    items.map((item) => ({
      tenant_id: input.tenant_id,
      return_id: created.id,
      sales_order_item_id: item.sales_order_item_id,
      quantity: item.quantity,
    })),
  )
  if (itemsError) {
    await supabase.from('returns').delete().eq('id', created.id)
    throw itemsError
  }

  return created
}

export interface ReturnUpdateInput {
  status_id?: string
  resolution_type_id?: string | null
  resolution_amount?: number | null
  notes?: string | null
}

export async function updateReturn(id: string, input: ReturnUpdateInput): Promise<Return> {
  const { data, error } = await supabase.from('returns').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export interface ReturnItemWithOrderItem extends ReturnItem {
  sales_order_item: Pick<SalesOrderItem, 'product_name' | 'sku' | 'quantity' | 'unit_price'> | null
}

export async function listReturnItems(returnId: string): Promise<ReturnItemWithOrderItem[]> {
  const { data, error } = await supabase
    .from('return_items')
    .select('*, sales_order_item:sales_order_items(product_name, sku, quantity, unit_price)')
    .eq('return_id', returnId)
    .order('created_at')
  if (error) throw error
  return data as unknown as ReturnItemWithOrderItem[]
}

/** El único campo que un agente realmente cambia sobre un return_item ya
 * creado -- inspeccionar el producto devuelto y marcar si volvió bueno o
 * dañado. Ese cambio es lo que dispara el efecto de inventario (ver
 * apply_return_item_stock_effect() en la migración), una sola vez por ítem. */
export async function setReturnItemCondition(id: string, condition: ReturnItemCondition): Promise<ReturnItem> {
  const { data, error } = await supabase.from('return_items').update({ condition }).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function listReturnHistory(returnId: string): Promise<ReturnStatusHistoryEntry[]> {
  const { data, error } = await supabase.from('return_status_history').select('*').eq('return_id', returnId).order('created_at')
  if (error) throw error
  return data
}

export async function listStoreCreditGrants(clientId: string): Promise<StoreCreditGrant[]> {
  const { data, error } = await supabase.from('store_credit_grants').select('*').eq('client_id', clientId).order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getStoreCreditBalance(clientId: string): Promise<number> {
  const { data, error } = await supabase.from('store_credit_grants').select('amount').eq('client_id', clientId)
  if (error) throw error
  return (data ?? []).reduce((sum, g) => sum + g.amount, 0)
}

/** Solo ítems que ya se entregaron (con producto/bodega asignados, igual
 * que el filtro que usa el efecto de inventario) tiene sentido ofrecer
 * para devolver -- una línea personalizada sin producto no puede volver a
 * bodega. */
export async function listReturnableItemsForOrder(salesOrderId: string): Promise<SalesOrderItem[]> {
  const { data, error } = await supabase
    .from('sales_order_items')
    .select('*')
    .eq('order_id', salesOrderId)
    .not('product_id', 'is', null)
    .order('display_order')
  if (error) throw error
  return data
}
