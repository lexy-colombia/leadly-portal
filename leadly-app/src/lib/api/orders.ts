import { supabase } from '../supabaseClient'
import type { CrmContactAddress, CrmOrder, CrmOrderItem, OrderStatus } from '../../types/domain'

export interface OrderItemInput {
  product_id?: string | null
  product_name: string
  sku?: string | null
  quantity: number
  unit_price: number
  discount_percentage?: number
}

export interface OrderInput {
  tenant_id: string
  contact_id: string
  opportunity_id?: string | null
  status?: OrderStatus
  currency?: string
  shipping?: number
  tax_total?: number
  notes?: string | null
  valid_until?: string | null
  shipping_address_id?: string | null
  billing_address_id?: string | null
  created_by?: string | null
}

export type OrderWithRelations = CrmOrder & {
  contact: { full_name: string; phone: string } | null
  opportunity: { title: string } | null
  shipping_address: { label: string | null; line1: string; city: string | null } | null
  billing_address: { label: string | null; line1: string; city: string | null } | null
}

const ORDER_SELECT =
  '*, contact:crm_contacts(full_name, phone), opportunity:crm_opportunities(title), shipping_address:crm_contact_addresses!shipping_address_id(label, line1, city), billing_address:crm_contact_addresses!billing_address_id(label, line1, city)'

/** Pure function: derives subtotal/discount_total/total from a set of line
 * items plus header-level shipping/tax -- the same shape both the drawer's
 * live preview and the actual save call use, so they can never disagree. */
export function computeOrderTotals(items: OrderItemInput[], shipping: number, taxTotal: number) {
  let subtotal = 0
  let discountTotal = 0
  for (const item of items) {
    const gross = item.quantity * item.unit_price
    const discount = gross * ((item.discount_percentage ?? 0) / 100)
    subtotal += gross
    discountTotal += discount
  }
  const total = subtotal - discountTotal + taxTotal + shipping
  return { subtotal, discountTotal, total }
}

export async function listOrders(tenantId: string): Promise<OrderWithRelations[]> {
  const { data, error } = await supabase
    .from('crm_orders')
    .select(ORDER_SELECT)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as OrderWithRelations[]
}

/** "Ventas" tab on ContactoDetalle.tsx. */
export async function listOrdersForContact(contactId: string): Promise<OrderWithRelations[]> {
  const { data, error } = await supabase
    .from('crm_orders')
    .select(ORDER_SELECT)
    .eq('contact_id', contactId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as OrderWithRelations[]
}

/** Read-only "Cotizaciones" section on OpportunityPanel.tsx's Resumen tab. */
export async function listOrdersForOpportunity(opportunityId: string): Promise<OrderWithRelations[]> {
  const { data, error } = await supabase
    .from('crm_orders')
    .select(ORDER_SELECT)
    .eq('opportunity_id', opportunityId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as OrderWithRelations[]
}

export type OrderDetail = CrmOrder & {
  contact: { id: string; full_name: string; phone: string } | null
  opportunity: { title: string } | null
  shipping_address: CrmContactAddress | null
  billing_address: CrmContactAddress | null
  created_by_profile: { full_name: string } | null
}

/** VentaDetalle.tsx -- unlike ORDER_SELECT (used by list views, which only
 * need a one-line address summary), the detail page shows every field of
 * the linked shipping/billing address, so this joins the full row. */
export async function getOrder(id: string): Promise<OrderDetail | null> {
  const { data, error } = await supabase
    .from('crm_orders')
    .select(
      '*, contact:crm_contacts(id, full_name, phone), opportunity:crm_opportunities(title), shipping_address:crm_contact_addresses!shipping_address_id(*), billing_address:crm_contact_addresses!billing_address_id(*), created_by_profile:profiles!created_by(full_name)',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  return data as unknown as OrderDetail | null
}

export async function listOrderItems(orderId: string): Promise<CrmOrderItem[]> {
  const { data, error } = await supabase.from('crm_order_items').select('*').eq('order_id', orderId).order('display_order', { ascending: true })
  if (error) throw error
  return data
}

/** Order + items don't have DB-level atomicity here (two round-trips, no
 * transaction) -- acceptable for a single-agent CRM form save, same
 * trade-off already made elsewhere in this codebase (e.g. task + its
 * attachment). Replaces the entire item set rather than diffing it: the
 * drawer always edits the full list at once, so delete-then-reinsert is
 * simpler than reconciling adds/edits/removes line by line. */
export async function saveOrderItems(tenantId: string, orderId: string, items: OrderItemInput[]): Promise<void> {
  const { error: deleteError } = await supabase.from('crm_order_items').delete().eq('order_id', orderId)
  if (deleteError) throw deleteError
  if (items.length === 0) return

  const rows = items.map((item, index) => {
    const gross = item.quantity * item.unit_price
    const discountPercentage = item.discount_percentage ?? 0
    const subtotal = gross * (1 - discountPercentage / 100)
    return {
      tenant_id: tenantId,
      order_id: orderId,
      product_id: item.product_id || null,
      product_name: item.product_name,
      sku: item.sku || null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_percentage: discountPercentage,
      subtotal,
      display_order: index,
    }
  })
  const { error: insertError } = await supabase.from('crm_order_items').insert(rows)
  if (insertError) throw insertError
}

export async function createOrder(input: OrderInput, items: OrderItemInput[]): Promise<CrmOrder> {
  const { subtotal, discountTotal, total } = computeOrderTotals(items, input.shipping ?? 0, input.tax_total ?? 0)
  const { data, error } = await supabase
    .from('crm_orders')
    .insert({ ...input, subtotal, discount_total: discountTotal, total })
    .select()
    .single()
  if (error) throw error
  await saveOrderItems(input.tenant_id, data.id, items)
  return data
}

export async function updateOrder(id: string, tenantId: string, input: Partial<OrderInput>, items: OrderItemInput[]): Promise<CrmOrder> {
  const { subtotal, discountTotal, total } = computeOrderTotals(items, input.shipping ?? 0, input.tax_total ?? 0)
  const { data, error } = await supabase
    .from('crm_orders')
    .update({ ...input, subtotal, discount_total: discountTotal, total })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  await saveOrderItems(tenantId, id, items)
  return data
}

/** Patches a handful of header fields (notes, shipping/billing address)
 * without touching items or recomputing totals -- used by VentaDetalle.tsx's
 * inline editors, where each section saves itself independently instead of
 * going through the full OrderDrawer form. */
export async function updateOrderFields(id: string, patch: Partial<OrderInput>): Promise<CrmOrder> {
  const { data, error } = await supabase.from('crm_orders').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Same "recompute totals + replace items" logic as updateOrder, but without
 * requiring the rest of OrderInput (contact_id, status, ...) -- VentaDetalle.tsx's
 * inline product editor only ever changes items/shipping/tax, never those. */
export async function updateOrderItemsAndTotals(id: string, tenantId: string, items: OrderItemInput[], shipping: number, taxTotal: number): Promise<CrmOrder> {
  const { subtotal, discountTotal, total } = computeOrderTotals(items, shipping, taxTotal)
  const { data, error } = await supabase
    .from('crm_orders')
    .update({ subtotal, discount_total: discountTotal, total, shipping, tax_total: taxTotal })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  await saveOrderItems(tenantId, id, items)
  return data
}

export async function updateOrderStatus(id: string, status: OrderStatus): Promise<CrmOrder> {
  const { data, error } = await supabase.from('crm_orders').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Only ever called on a still-open cotización (Ventas.tsx hides this action
 * once an order becomes a venta, see updateOrderStatus/'cancelada' for
 * voiding one of those instead). Sets status to 'cancelada' in the same
 * update as the soft-delete -- not two separate calls -- so the stock-effect
 * trigger on crm_orders (20260809000001_order_stock_effects.sql) sees the
 * cotizacion -> cancelada transition and releases the reserved stock;
 * deleted_at alone wouldn't fire it. */
export async function deleteOrder(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('crm_orders')
    .update({ status: 'cancelada', deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}
