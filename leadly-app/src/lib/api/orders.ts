import { supabase } from '../supabaseClient'
import type { ContactAddress, SalesOrder, SalesOrderItem, OrderStatus, DeliveryStatus } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

// Shared between Orders.tsx and OrderDetail.tsx so the status wording
// never drifts between screens. Estado *comercial* de la orden -- ver
// DELIVERY_STATUS_LABEL_KEY para el estado de envío, un concepto separado
// desde el 2026-08-20.
export const ORDER_STATUS_LABEL_KEY: Record<OrderStatus, TranslationKey> = {
  cotizacion: 'orders.status.quote',
  confirmada: 'orders.status.confirmed',
  cancelada: 'orders.status.cancelled',
}

// Same bg/text pair convention as Clients.tsx's STAGE_BADGE_CLASS -- shadcn
// Badge has no built-in "warning"/"success" tone, unlike the legacy atoms
// Badge these two screens replaced.
export const ORDER_STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  cotizacion: 'border-transparent bg-slate-100 text-slate-600',
  confirmada: 'border-transparent bg-emerald-100 text-emerald-700',
  cancelada: 'border-transparent bg-red-100 text-red-700',
}

export const DELIVERY_STATUS_LABEL_KEY: Record<DeliveryStatus, TranslationKey> = {
  pendiente: 'orders.deliveryStatus.pendiente',
  en_camino: 'orders.deliveryStatus.enCamino',
  entregado: 'orders.deliveryStatus.entregado',
}

export const DELIVERY_STATUS_BADGE_CLASS: Record<DeliveryStatus, string> = {
  pendiente: 'border-transparent bg-slate-100 text-slate-600',
  en_camino: 'border-transparent bg-amber-100 text-amber-700',
  entregado: 'border-transparent bg-emerald-100 text-emerald-700',
}

// Solid-color counterparts of the two badge-class maps above, for the small
// status dots in Orders.tsx's "Estados" column (label + dot + text, instead
// of a pill badge -- pedido explícito del usuario, referencia de diseño).
export const ORDER_STATUS_DOT_CLASS: Record<OrderStatus, string> = {
  cotizacion: 'bg-slate-400',
  confirmada: 'bg-emerald-500',
  cancelada: 'bg-red-500',
}

export const DELIVERY_STATUS_DOT_CLASS: Record<DeliveryStatus, string> = {
  pendiente: 'bg-slate-400',
  en_camino: 'bg-amber-500',
  entregado: 'bg-emerald-500',
}

export interface OrderItemInput {
  product_id?: string | null
  variant_id?: string | null
  warehouse_id?: string | null
  product_name: string
  sku?: string | null
  quantity: number
  unit_price: number
  /** Flat amount subtracted from this line's gross (quantity * unit_price),
   * not a percentage -- explicit product decision, ver CLAUDE.md. */
  discount_amount?: number
}

/** True if any item points at a variant-enabled product but hasn't picked a
 * specific variant yet -- a line like that would silently save with
 * unit_price 0 (see OrderItemsEditor.handleProductSelect) and no way to
 * know which combination was actually sold, so OrderDetail.tsx (both the
 * create form and the batch item save) blocks on this before calling
 * saveOrderItems. */
export function hasIncompleteVariantSelection(items: OrderItemInput[], products: { id: string; has_variants: boolean }[]): boolean {
  return items.some((item) => {
    if (!item.product_id) return false
    const product = products.find((p) => p.id === item.product_id)
    return !!product?.has_variants && !item.variant_id
  })
}

export interface StockShortfall {
  productId: string
  variantId: string | null
  warehouseId: string
  productName: string
  sku: string | null
  warehouseName: string
  requested: number
  available: number
}

/** Fresh product_stock read (not whatever snapshot the page happened to
 * load on mount) for every line that points at a real product+warehouse --
 * called at the exact moment a cotización turns into a venta (see
 * OrderDetail.tsx's handleStatusSelect/handleCreate and Orders.tsx's
 * handleConfirm), never while it's still a cotización, which is allowed to
 * quote more than what's physically on hand. Lines without a product_id
 * (custom lines) or without a warehouse chosen are skipped -- there's
 * nothing to check them against. */
export async function findStockShortfalls(tenantId: string, items: OrderItemInput[], warehouses: { id: string; name: string }[]): Promise<StockShortfall[]> {
  const relevant = items.filter((i) => i.product_id && i.warehouse_id && i.quantity > 0)
  if (relevant.length === 0) return []

  const productIds = Array.from(new Set(relevant.map((i) => i.product_id as string)))
  const { data, error } = await supabase.from('product_stock').select('product_id, variant_id, warehouse_id, quantity').eq('tenant_id', tenantId).in('product_id', productIds)
  if (error) throw error
  const rows = data as { product_id: string; variant_id: string | null; warehouse_id: string; quantity: number }[]

  const shortfalls: StockShortfall[] = []
  for (const item of relevant) {
    const available = rows
      .filter((r) => r.product_id === item.product_id && r.warehouse_id === item.warehouse_id && r.variant_id === (item.variant_id ?? null))
      .reduce((sum, r) => sum + r.quantity, 0)
    if (available < item.quantity) {
      shortfalls.push({
        productId: item.product_id as string,
        variantId: item.variant_id ?? null,
        warehouseId: item.warehouse_id as string,
        productName: item.product_name,
        sku: item.sku ?? null,
        warehouseName: warehouses.find((w) => w.id === item.warehouse_id)?.name ?? '—',
        requested: item.quantity,
        available,
      })
    }
  }
  return shortfalls
}

export interface OrderInput {
  tenant_id: string
  contact_id: string
  opportunity_id?: string | null
  status?: OrderStatus
  delivery_status?: DeliveryStatus
  currency?: string
  shipping?: number
  tax_total?: number
  notes?: string | null
  valid_until?: string | null
  shipping_address_id?: string | null
  billing_address_id?: string | null
  created_by?: string | null
}

export type OrderWithRelations = SalesOrder & {
  contact: { full_name: string; phone: string } | null
  opportunity: { title: string } | null
  shipping_address: { label: string | null; line1: string; city: string | null; state_province: string | null } | null
  billing_address: { label: string | null; line1: string; city: string | null } | null
  // Embedded PostgREST count aggregate (`sales_order_items(count)`) --
  // always a one-element array, never the actual item rows. Used by
  // Orders.tsx to show "N items" under the total without a second query
  // per order.
  items: { count: number }[]
}

const ORDER_SELECT =
  '*, contact:clients(full_name, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(label, line1, city, state_province), billing_address:contact_addresses!billing_address_id(label, line1, city), items:sales_order_items(count)'

/** Pure function: derives subtotal/discount_total/total from a set of line
 * items plus header-level shipping/tax -- the same shape both the drawer's
 * live preview and the actual save call use, so they can never disagree. */
export function computeOrderTotals(items: OrderItemInput[], shipping: number, taxTotal: number) {
  let subtotal = 0
  let discountTotal = 0
  for (const item of items) {
    const gross = item.quantity * item.unit_price
    const discount = item.discount_amount ?? 0
    subtotal += gross
    discountTotal += discount
  }
  const total = subtotal - discountTotal + taxTotal + shipping
  return { subtotal, discountTotal, total }
}

export async function listOrders(tenantId: string): Promise<OrderWithRelations[]> {
  const { data, error } = await supabase
    .from('sales_orders')
    .select(ORDER_SELECT)
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as OrderWithRelations[]
}

/** "Orders" tab on ClientDetail.tsx. */
export async function listOrdersForContact(contactId: string): Promise<OrderWithRelations[]> {
  const { data, error } = await supabase
    .from('sales_orders')
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
    .from('sales_orders')
    .select(ORDER_SELECT)
    .eq('opportunity_id', opportunityId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as OrderWithRelations[]
}

export type OrderDetail = SalesOrder & {
  contact: { id: string; full_name: string; phone: string } | null
  opportunity: { title: string } | null
  shipping_address: ContactAddress | null
  billing_address: ContactAddress | null
  created_by_profile: { full_name: string } | null
}

/** OrderDetail.tsx -- unlike ORDER_SELECT (used by list views, which only
 * need a one-line address summary), the detail page shows every field of
 * the linked shipping/billing address, so this joins the full row. */
export async function getOrder(id: string): Promise<OrderDetail | null> {
  const { data, error } = await supabase
    .from('sales_orders')
    .select(
      '*, contact:clients(id, full_name, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(*), billing_address:contact_addresses!billing_address_id(*), created_by_profile:profiles!created_by(full_name)',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw error
  return data as unknown as OrderDetail | null
}

export async function listOrderItems(orderId: string): Promise<SalesOrderItem[]> {
  const { data, error } = await supabase.from('sales_order_items').select('*').eq('order_id', orderId).order('display_order', { ascending: true })
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
  const { error: deleteError } = await supabase.from('sales_order_items').delete().eq('order_id', orderId)
  if (deleteError) throw deleteError
  if (items.length === 0) return

  const rows = items.map((item, index) => {
    const gross = item.quantity * item.unit_price
    const discountAmount = item.discount_amount ?? 0
    const subtotal = gross - discountAmount
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
      discount_amount: discountAmount,
      subtotal,
      display_order: index,
    }
  })
  const { error: insertError } = await supabase.from('sales_order_items').insert(rows)
  if (insertError) throw insertError
}

export async function createOrder(input: OrderInput, items: OrderItemInput[]): Promise<SalesOrder> {
  const { subtotal, discountTotal, total } = computeOrderTotals(items, input.shipping ?? 0, input.tax_total ?? 0)
  const { data, error } = await supabase
    .from('sales_orders')
    .insert({ ...input, subtotal, discount_total: discountTotal, total })
    .select()
    .single()
  if (error) throw error
  await saveOrderItems(input.tenant_id, data.id, items)
  return data
}

export async function updateOrder(id: string, tenantId: string, input: Partial<OrderInput>, items: OrderItemInput[]): Promise<SalesOrder> {
  const { subtotal, discountTotal, total } = computeOrderTotals(items, input.shipping ?? 0, input.tax_total ?? 0)
  const { data, error } = await supabase
    .from('sales_orders')
    .update({ ...input, subtotal, discount_total: discountTotal, total })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  await saveOrderItems(tenantId, id, items)
  return data
}

/** Patches a handful of header fields (contact, opportunity, status, notes,
 * shipping/billing address...) without touching items or recomputing
 * totals -- used by OrderDetail.tsx's per-field autosave, where each
 * section saves itself independently the moment it changes instead of
 * going through one big form submit. */
export async function updateOrderFields(id: string, patch: Partial<OrderInput>): Promise<SalesOrder> {
  const { data, error } = await supabase.from('sales_orders').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Same "recompute totals + replace items" logic as updateOrder, but without
 * requiring the rest of OrderInput (contact_id, status, ...) -- OrderDetail.tsx's
 * inline product editor only ever changes items/shipping/tax, never those. */
export async function updateOrderItemsAndTotals(id: string, tenantId: string, items: OrderItemInput[], shipping: number, taxTotal: number): Promise<SalesOrder> {
  const { subtotal, discountTotal, total } = computeOrderTotals(items, shipping, taxTotal)
  const { data, error } = await supabase
    .from('sales_orders')
    .update({ subtotal, discount_total: discountTotal, total, shipping, tax_total: taxTotal })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  await saveOrderItems(tenantId, id, items)
  return data
}

export async function updateOrderStatus(id: string, status: OrderStatus): Promise<SalesOrder> {
  const { data, error } = await supabase.from('sales_orders').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Independent from updateOrderStatus -- delivery_status never gates or is
 * gated by the order's commercial status (see types/domain.ts), so it's
 * its own plain update with no stock check or any other side effect. */
export async function updateDeliveryStatus(id: string, deliveryStatus: DeliveryStatus): Promise<SalesOrder> {
  const { data, error } = await supabase.from('sales_orders').update({ delivery_status: deliveryStatus }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Only ever called on a still-open cotización (Orders.tsx hides this action
 * once an order becomes a venta, see updateOrderStatus/'cancelada' for
 * voiding one of those instead). Sets status to 'cancelada' in the same
 * update as the soft-delete, mirroring the old crm_orders behavior -- no
 * stock-effect trigger exists on sales_orders yet (ver core_sales.sql: el
 * efecto de stock por bodega queda para la Fase de Despachos). */
export async function deleteOrder(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('sales_orders')
    .update({ status: 'cancelada', deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}
