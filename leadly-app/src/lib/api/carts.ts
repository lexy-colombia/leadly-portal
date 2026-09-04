import { supabase } from '../supabaseClient'
import type { OrderItemInput } from './orders'
import type { Cart, CartItem, OrderPaymentMethod, SalesOrder } from '../../types/domain'

export type CartWithItems = Cart & { items: CartItem[] }

/** Mismo manejo de error que calculateOrder -- un 4xx/5xx de la función
 * llega como FunctionsHttpError con el cuerpo sin parsear, hay que leerlo
 * para mostrar el mensaje real en vez de uno genérico. */
async function invokeAndUnwrap<T>(name: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(name, { body })
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
  if (data && (data as { error?: string }).error) throw new Error((data as { error?: string }).error)
  return data as T
}

export interface SaveCartDraftInput {
  cart_id?: string | null
  contact_id?: string
  opportunity_id?: string | null
  notes?: string | null
  valid_until?: string | null
  shipping_address_id?: string | null
  billing_address_id?: string | null
  shipping?: number
  items: OrderItemInput[]
  origin?: 'portal' | 'pos'
  pos_point_id?: string | null
  label?: string | null
}

/** Arma/edita un carrito -- calculate-order sin order_id, ver el
 * comentario de cabecera de esa Edge Function. Nunca toca sales_orders. */
export async function saveCartDraft(input: SaveCartDraftInput): Promise<CartWithItems> {
  const { cart } = await invokeAndUnwrap<{ cart: CartWithItems }>('calculate-order', input)
  return cart
}

/** Único momento en que un carrito se convierte en un pedido real -- ver
 * comentario de cabecera de create-order. `items` es opcional: sin él,
 * cobra el carrito completo (portal, o "cobrar todo" del POS); con una
 * lista de `{id, quantity}`, cobra solo esas cantidades (pueden ser menos
 * que lo que tiene la línea, ej. 1 de 3 cervezas) y deja el resto en el
 * mismo carrito, todavía abierto -- así se puede dividir una cuenta por
 * producto. */
export async function createOrderFromCart(
  cartId: string,
  items?: { id: string; quantity: number }[],
  { keepCartOpen = false, confirm = false }: { keepCartOpen?: boolean; confirm?: boolean } = {},
): Promise<SalesOrder> {
  return invokeAndUnwrap<SalesOrder>('create-order', { cart_id: cartId, items, keep_cart_open: keepCartOpen, confirm })
}

/** Cerrar la mesa -- deliberadamente separado de cobrar (pedido explícito
 * del usuario): se puede cobrar una cuenta y dejarla abierta para que siga
 * consumiendo, así que el carrito solo pasa a `converted` cuando el cajero
 * lo decide acá. Es un update directo (RLS ya aísla por tenant, misma vía
 * que deleteCart) y solo aplica sobre una cuenta todavía abierta. */
export async function closeCart(cartId: string): Promise<void> {
  const { error } = await supabase.from('carts').update({ status: 'converted' }).eq('id', cartId).eq('status', 'open')
  if (error) throw error
}

/** Cancela un borrador que nunca llegó a ser un pedido -- delete real, sin
 * traza (decisión explícita del usuario). RLS ya aísla por tenant. */
export async function deleteCart(cartId: string): Promise<void> {
  const { error } = await supabase.from('carts').delete().eq('id', cartId).eq('status', 'open')
  if (error) throw error
}

/** Un cobro ya hecho sobre esta cuenta: el pedido real que salió de ella,
 * con sus líneas y cuánto se le pagó. */
export interface CartCharge {
  id: string
  number: number
  currency: string
  total: number
  paid: number
  created_at: string
  items: { product_name: string; quantity: number; subtotal: number }[]
}

/** Lo ya cobrado de esta cuenta. Los productos cobrados salen del carrito
 * (ahí solo vive lo que falta cobrar) y pasan a vivir en su pedido, así que
 * este es el único lugar donde el cajero puede ver qué se llevó la mesa y
 * si quedó pago o debiendo. También decide si la cuenta todavía se puede
 * "cancelar": con al menos un cobro hecho no se puede (el borrado real
 * perdería el vínculo con esos pedidos, sales_orders.cart_id es ON DELETE
 * SET NULL) -- se cierra. */
export async function listChargesFromCart(cartId: string): Promise<CartCharge[]> {
  const { data, error } = await supabase
    .from('sales_orders')
    .select('id, number, currency, total, created_at, items:sales_order_items(product_name, quantity, subtotal, display_order), payments:sales_order_payments(amount, deleted_at)')
    .eq('cart_id', cartId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error

  return (
    data as unknown as Array<{
      id: string
      number: number
      currency: string
      total: number
      created_at: string
      items: { product_name: string; quantity: number; subtotal: number; display_order: number }[]
      payments: { amount: number; deleted_at: string | null }[]
    }>
  ).map((row) => ({
    id: row.id,
    number: row.number,
    currency: row.currency,
    total: row.total,
    // Un pago borrado (se registró por error) no cuenta -- mismo criterio
    // que OrderDetail.tsx al calcular el saldo pendiente.
    paid: row.payments.filter((p) => !p.deleted_at).reduce((sum, p) => sum + p.amount, 0),
    created_at: row.created_at,
    items: row.items
      .slice()
      .sort((a, b) => a.display_order - b.display_order)
      .map((i) => ({ product_name: i.product_name, quantity: i.quantity, subtotal: i.subtotal })),
  }))
}

export async function getCart(cartId: string): Promise<CartWithItems | null> {
  const { data, error } = await supabase.from('carts').select('*, items:cart_items(*)').eq('id', cartId).maybeSingle()
  if (error) throw error
  return data
}

export interface OpenCartSummary {
  id: string
  label: string | null
  pos_point_id: string | null
  contact_name: string
  contact_phone: string | null
  contact_phone_prefix: string | null
  total: number
  item_count: number
  created_at: string
  updated_at: string
  /** Métodos de pago de los cobros que YA salieron de esta cuenta, de mayor
   * a menor monto -- misma forma que espera OrderPaymentMethodCell en la
   * tabla de Ventas, que el POS reusa tal cual. */
  payment_methods: { method: OrderPaymentMethod; amount: number }[]
  /** Cuántos pedidos ya se cobraron desde esta cuenta: con al menos uno no
   * se puede cancelar (borrar el carrito perdería el vínculo, FK ON DELETE
   * SET NULL) -- se cierra. */
  charge_count: number
}

/** Carritos abiertos del tenant para un origen dado -- landing de
 * PosOpenTabs.tsx (origin='pos'). El total se calcula acá mismo (sin
 * impuesto, igual que los ítems del carrito) sumando quantity*unit_price
 * menos descuento -- una aproximación honesta para la lista, el total
 * real recién existe cuando el carrito se convierte en pedido. */
export async function listOpenCarts(tenantId: string, origin: 'portal' | 'pos'): Promise<OpenCartSummary[]> {
  const { data, error } = await supabase
    .from('carts')
    .select('id, label, pos_point_id, created_at, updated_at, contact:clients(full_name, phone, phone_prefix), items:cart_items(quantity, unit_price, discount_amount)')
    .eq('tenant_id', tenantId)
    .eq('origin', origin)
    .eq('status', 'open')
    .order('updated_at', { ascending: true })
  if (error) throw error

  const rows = data as unknown as Array<{
    id: string
    label: string | null
    pos_point_id: string | null
    created_at: string
    updated_at: string
    contact: { full_name: string; phone: string | null; phone_prefix: string | null } | null
    items: { quantity: number; unit_price: number; discount_amount: number }[]
  }>

  // Los cobros ya hechos de todas estas cuentas en UNA consulta, no una por
  // fila -- mismo criterio que `payments` en Orders.tsx.
  const chargesByCart = new Map<string, { method: OrderPaymentMethod; amount: number }[]>()
  const chargeCountByCart = new Map<string, number>()
  if (rows.length > 0) {
    const { data: charges, error: chargesError } = await supabase
      .from('sales_orders')
      .select('id, cart_id, payments:sales_order_payments(method, amount, deleted_at)')
      .in('cart_id', rows.map((r) => r.id))
      .is('deleted_at', null)
    if (chargesError) throw chargesError
    for (const order of (charges ?? []) as unknown as Array<{
      cart_id: string
      payments: { method: OrderPaymentMethod; amount: number; deleted_at: string | null }[]
    }>) {
      chargeCountByCart.set(order.cart_id, (chargeCountByCart.get(order.cart_id) ?? 0) + 1)
      const list = chargesByCart.get(order.cart_id) ?? []
      for (const payment of order.payments.filter((p) => !p.deleted_at)) {
        const existing = list.find((m) => m.method === payment.method)
        if (existing) existing.amount += payment.amount
        else list.push({ method: payment.method, amount: payment.amount })
      }
      chargesByCart.set(order.cart_id, list)
    }
    for (const list of chargesByCart.values()) list.sort((a, b) => b.amount - a.amount)
  }

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    pos_point_id: row.pos_point_id,
    contact_name: row.contact?.full_name ?? '—',
    contact_phone: row.contact?.phone ?? null,
    contact_phone_prefix: row.contact?.phone_prefix ?? null,
    total: row.items.reduce((sum, i) => sum + i.quantity * i.unit_price - (i.discount_amount ?? 0), 0),
    item_count: row.items.reduce((sum, i) => sum + i.quantity, 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    payment_methods: chargesByCart.get(row.id) ?? [],
    charge_count: chargeCountByCart.get(row.id) ?? 0,
  }))
}

/** Mismo patrón que subscribeToConversations (lib/api/conversations.ts) --
 * recarga completa en cualquier cambio, no un merge fila a fila. */
export function subscribeToOpenCarts(tenantId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`open_carts:${tenantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'carts', filter: `tenant_id=eq.${tenantId}` }, onChange)
    .subscribe()
  return () => {
    supabase.removeChannel(channel)
  }
}
