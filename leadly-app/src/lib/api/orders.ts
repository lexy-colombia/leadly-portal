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
  /** Copiados del producto al agregar la línea (snapshot, no referencia
   * viva -- mismo criterio que product_name/sku), solo para que
   * OrderItemsEditor los tenga a mano si hace falta mostrarlos -- el
   * impuesto real de cada línea (tax_amount/taxable_base) NUNCA se calcula
   * acá. calculate-order (Edge Function) resuelve el impuesto del lado del
   * servidor contra la tabla products real -- pedido explícito del
   * usuario 2026-09-03: cero cálculos de negocio en el frontend, ni
   * siquiera como preview. */
  tax_type_code?: string | null
  tax_rate?: number
}

/** True if any item points at a variant-enabled product but hasn't picked a
 * specific variant yet -- a line like that would silently save with
 * unit_price 0 (see OrderItemsEditor.handleProductSelect) and no way to
 * know which combination was actually sold, so OrderDetail.tsx (both the
 * create form and the autosave) blocks on this before calling
 * calculateOrder. */
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
  notes?: string | null
  valid_until?: string | null
  shipping_address_id?: string | null
  billing_address_id?: string | null
  created_by?: string | null
}

export type OrderWithRelations = SalesOrder & {
  contact: { full_name: string; phone_prefix: string; phone: string } | null
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
  '*, contact:clients(full_name, phone_prefix, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(label, line1, city, state_province), billing_address:contact_addresses!billing_address_id(label, line1, city), items:sales_order_items(count)'

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
  contact: { id: string; full_name: string; phone_prefix: string; phone: string } | null
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
      '*, contact:clients(id, full_name, phone_prefix, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(*), billing_address:contact_addresses!billing_address_id(*), created_by_profile:profiles!created_by(full_name)',
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

/** Único punto de escritura para los ítems de un pedido y sus totales
 * derivados. Llama al Edge Function centralizado (calculate-order), que
 * corre exactamente el mismo cálculo de impuesto/totales que
 * whatsapp-ai-tools y storefront (_shared/orders/persistOrderItems.ts) --
 * el portal nunca lo reimplementa por su cuenta. Pedido explícito del
 * usuario 2026-09-03: nada de lógica de negocio condicionada a "quién
 * llama", y un único proceso para todo el estado editable del pedido
 * (cliente, oportunidad, direcciones, envío, ítems) -- sin `order_id`
 * crea un pedido nuevo (siempre en 'cotizacion', ver comentario grande en
 * el Edge Function sobre por qué confirmar es un paso aparte). El
 * impuesto de cada línea se resuelve del lado del servidor contra la
 * tabla products real, no confía en lo que el navegador tenga cargado.
 *
 * Deliberadamente AFUERA de este alcance: pagos (su propio flujo,
 * orderPayments.ts) y el status del pedido (updateOrderStatus, ya
 * validado por los triggers de confirmación -- ver
 * 20260903180000_sales_order_confirm_triggers.sql).
 *
 * Reemplaza TODOS los ítems del pedido (no hace merge/diff) -- el drawer
 * siempre edita la lista completa a la vez. Devuelve el pedido ya
 * actualizado (subtotal/discount_total/total/tax_total reales) -- el
 * frontend nunca calcula estos valores, solo pinta lo que llega acá. */
export interface CalculateOrderInput {
  order_id?: string | null
  contact_id?: string
  opportunity_id?: string | null
  notes?: string | null
  valid_until?: string | null
  shipping_address_id?: string | null
  billing_address_id?: string | null
  shipping: number
  items: OrderItemInput[]
}

export async function calculateOrder(input: CalculateOrderInput): Promise<SalesOrder> {
  const { data, error } = await supabase.functions.invoke<SalesOrder & { error?: string }>('calculate-order', { body: input })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const responseBody = await context.json()
        specificMessage = responseBody?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  return data as SalesOrder
}

/** Pasar a "confirmada" corre dos triggers de DB (guard_sales_order_confirmation
 * / apply_sales_order_confirmed_effects, 20260903180000_sales_order_confirm_triggers.sql)
 * que validan stock/dirección y reservan la factura DIAN + mueven la
 * oportunidad -- aplican sobre este UPDATE igual que sobre el de la IA o
 * la tienda pública, no hace falta ninguna llamada extra acá. Si el
 * trigger BEFORE rechaza la transacción, el mensaje viene con un prefijo
 * tipo "BILLING_ADDRESS_REQUIRED: " -- se saca antes de mostrarlo, el
 * resto del texto ya es un mensaje claro en español. */
export async function updateOrderStatus(id: string, status: OrderStatus): Promise<SalesOrder> {
  const { data, error } = await supabase.from('sales_orders').update({ status }).eq('id', id).select().single()
  if (error) {
    const cleaned = error.message.replace(/^[A-Z_]+:\s*/, '')
    throw new Error(cleaned || error.message)
  }
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
