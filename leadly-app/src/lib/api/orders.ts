import { supabase } from '../supabaseClient'
import type { ContactAddress, SalesOrder, SalesOrderItem, OrderStatus, OrderPaymentMethod, DeliveryStatus } from '../../types/domain'
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

/** Etiqueta de "por dónde entró el pedido" (sales_orders.sales_channel).
 * Lo setean los cuatro caminos que crean un pedido: create-order (portal o
 * POS según el origen del carrito), pos-checkout, whatsapp-ai-tools y la
 * tienda pública. `null` solo en filas anteriores al backfill de
 * 20260904180000. */
export const SALES_CHANNEL_LABEL_KEY: Record<'pos' | 'whatsapp' | 'storefront' | 'portal', TranslationKey> = {
  portal: 'orders.channel.portal',
  pos: 'orders.channel.pos',
  whatsapp: 'orders.channel.whatsapp',
  storefront: 'orders.channel.storefront',
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
  // Solo presente en las filas que devuelve listOrdersPage (list-sales-orders)
  // -- embebido ahí para que la columna "Método de pago" no necesite un
  // fetch de sales_order_payments aparte, ver OrderTableCells.tsx.
  payments?: { method: OrderPaymentMethod; amount: number }[]
}

const ORDER_SELECT =
  '*, contact:clients(full_name, phone_prefix, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(label, line1, city, state_province), billing_address:contact_addresses!billing_address_id(label, line1, city), items:sales_order_items(count)'

// PostgREST corta cualquier select en 1000 filas por request (db.max_rows) --
// un tenant con más de 1000 pedidos dejaba de ver el resto en Orders.tsx sin
// ningún error visible. Se pagina en batches de a 1000 hasta agotar el
// resultado, en vez de un solo .select() sin límite.
const ORDER_FETCH_CHUNK_SIZE = 1000

export async function listOrders(tenantId: string): Promise<OrderWithRelations[]> {
  const all: OrderWithRelations[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('sales_orders')
      .select(ORDER_SELECT)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, from + ORDER_FETCH_CHUNK_SIZE - 1)
    if (error) throw error
    const rows = data as unknown as OrderWithRelations[]
    all.push(...rows)
    if (rows.length < ORDER_FETCH_CHUNK_SIZE) break
    from += ORDER_FETCH_CHUNK_SIZE
  }
  return all
}

export interface OrdersSummary {
  count: number
  total: number
  currency: string
  paid: number
  pending: number
  average: number
  byMethod: Partial<Record<OrderPaymentMethod, number>>
  topTables: { table: string; count: number; total: number }[]
}

export interface ListOrdersPageParams {
  page: number
  pageSize: number
  status?: OrderStatus | null
  channel?: SalesOrder['sales_channel']
  contactId?: string | null
  /** YYYY-MM-DD, ambos inclusive -- resueltos server-side. */
  dateFrom?: string | null
  dateTo?: string | null
  search?: string
}

export interface ListOrdersPageResult {
  data: OrderWithRelations[]
  count: number
  totalPages: number
  summary: OrdersSummary
}

/** Pantalla "Órdenes" (Orders.tsx) -- reemplaza el viejo listOrders(tenantId)
 * sin límite, que traía TODO el historial del tenant a la vez (un tenant
 * real ya tiene 23.051 pedidos). Paginación real con offset en la DB
 * (Edge Function list-sales-orders, que usa .range()) en vez de traer todo
 * y cortar en el navegador -- el resumen (total vendido/pagado/pendiente/
 * por método/ranking de mesas) también se calcula server-side ahí mismo,
 * por la misma razón: sumarlo en el cliente exigiría tener todas las filas
 * en algún momento. */
export async function listOrdersPage(params: ListOrdersPageParams): Promise<ListOrdersPageResult> {
  const { data, error } = await supabase.functions.invoke<{
    data: OrderWithRelations[]
    count: number
    total_pages: number
    summary: {
      count: number
      total: number
      currency: string
      paid: number
      pending: number
      average: number
      by_method: Record<string, number>
      top_tables: { table: string; count: number; total: number }[]
    }
    error?: string
  }>('list-sales-orders', {
    body: {
      page: params.page,
      page_size: params.pageSize,
      status: params.status ?? null,
      channel: params.channel ?? null,
      contact_id: params.contactId ?? null,
      date_from: params.dateFrom ?? null,
      date_to: params.dateTo ?? null,
      search: params.search ?? '',
    },
  })
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
  if (!data || data.error) throw new Error(data?.error ?? 'No se pudieron cargar las órdenes.')
  return {
    data: data.data,
    count: data.count,
    totalPages: data.total_pages,
    summary: {
      count: data.summary.count,
      total: data.summary.total,
      currency: data.summary.currency,
      paid: data.summary.paid,
      pending: data.summary.pending,
      average: data.summary.average,
      byMethod: data.summary.by_method as Partial<Record<OrderPaymentMethod, number>>,
      topTables: data.summary.top_tables,
    },
  }
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
  // Reemplaza al viejo bloque de texto libre "Detalle del punto de venta"
  // (pos_table/pos_room/etc, migración de Fudo -- nunca se llegó a poblar,
  // se borró 2026-09-05) -- ahora es la relación real que ya usa el POS en
  // vivo (PosTabAccount.tsx), null si el pedido no vino de un punto de venta.
  pos_point: { name: string } | null
}

/** OrderDetail.tsx -- unlike ORDER_SELECT (used by list views, which only
 * need a one-line address summary), the detail page shows every field of
 * the linked shipping/billing address, so this joins the full row. */
export async function getOrder(id: string): Promise<OrderDetail | null> {
  const { data, error } = await supabase
    .from('sales_orders')
    .select(
      '*, contact:clients(id, full_name, phone_prefix, phone), opportunity:opportunities(title), shipping_address:contact_addresses!shipping_address_id(*), billing_address:contact_addresses!billing_address_id(*), created_by_profile:profiles!created_by(full_name), pos_point:pos_points(name)',
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

/** Desglose de impuestos tal como lo calculó y guardó el servidor -- se usa
 * para MOSTRAR (resumen de pago, POS), nunca para recalcular nada. */
export interface OrderTaxLine {
  tax_type_code: string | null
  tax_rate: number
  base: number
  amount: number
}

export interface OrderTotalsBreakdown {
  tax_enabled: boolean
  subtotal: number
  discount_total: number
  taxable_base: number
  tax_total: number
  shipping: number
  total: number
  tax_lines: OrderTaxLine[]
}

/** Desglose de lo que se va a cobrar ANTES de que exista el pedido (carrito
 * del POS en memoria, cuenta abierta). No escribe nada: es `calculate-order`
 * en modo `preview`, que resuelve el impuesto contra la tabla `products`
 * real con el mismo computeOrderTotals que después persiste el pedido.
 * Nunca se calcula acá -- ver la regla del proyecto de cero lógica de
 * negocio en el frontend. */
export async function previewOrderTotals(items: OrderItemInput[], shipping = 0): Promise<OrderTotalsBreakdown> {
  const { data, error } = await supabase.functions.invoke<{ totals: OrderTotalsBreakdown; error?: string }>('calculate-order', {
    body: { preview: true, items, shipping },
  })
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
  if (data?.error) throw new Error(data.error)
  return (data as { totals: OrderTotalsBreakdown }).totals
}

/** Mismo desglose, pero de un pedido que YA existe: sale de los valores que
 * el servidor guardó en sales_order_items (tax_amount/taxable_base por
 * línea), agrupados por impuesto y tarifa. Cero aritmética de negocio --
 * solo se suman columnas ya calculadas para poder mostrarlas discriminadas. */
export async function getOrderTotalsBreakdown(order: SalesOrder): Promise<OrderTotalsBreakdown> {
  const { data, error } = await supabase
    .from('sales_order_items')
    .select('tax_type_code, tax_rate, tax_amount, taxable_base')
    .eq('order_id', order.id)
  if (error) throw error

  const grouped = new Map<string, OrderTaxLine>()
  let taxableBase = 0
  for (const row of (data ?? []) as { tax_type_code: string | null; tax_rate: number; tax_amount: number; taxable_base: number }[]) {
    taxableBase += row.taxable_base
    if (!row.tax_rate) continue
    const key = `${row.tax_type_code ?? ''}:${row.tax_rate}`
    const existing = grouped.get(key)
    if (existing) {
      existing.base += row.taxable_base
      existing.amount += row.tax_amount
    } else {
      grouped.set(key, { tax_type_code: row.tax_type_code, tax_rate: row.tax_rate, base: row.taxable_base, amount: row.tax_amount })
    }
  }

  return {
    tax_enabled: order.tax_total > 0,
    subtotal: order.subtotal,
    discount_total: order.discount_total,
    taxable_base: taxableBase,
    tax_total: order.tax_total,
    shipping: order.shipping,
    total: order.total,
    tax_lines: Array.from(grouped.values()).sort((a, b) => b.tax_rate - a.tax_rate),
  }
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
