import { supabase } from '../supabaseClient'
import type { SalesOrderPayment, OrderPaymentMethod } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

// Shared between OrderDetail.tsx (payment list) and PaymentDrawer.tsx (method
// select) so the wording never drifts between screens.
export const PAYMENT_METHOD_LABEL_KEY: Record<OrderPaymentMethod, TranslationKey> = {
  efectivo: 'orders.paymentMethod.cash',
  transferencia: 'orders.paymentMethod.transfer',
  tarjeta: 'orders.paymentMethod.card',
  credito: 'orders.paymentMethod.credit',
  saldo_favor: 'orders.paymentMethod.storeCredit',
  wompi: 'orders.paymentMethod.wompi',
}

export interface OrderPaymentInput {
  tenant_id: string
  order_id: string
  method: OrderPaymentMethod
  amount: number
  currency?: string
  paid_at?: string
  notes?: string | null
}

export async function listPaymentsForOrder(orderId: string): Promise<SalesOrderPayment[]> {
  const { data, error } = await supabase
    .from('sales_order_payments')
    .select('*')
    .eq('order_id', orderId)
    .is('deleted_at', null)
    .order('paid_at', { ascending: false })
  if (error) throw error
  return data
}

/** Whole-tenant fetch (not scoped to one order) -- feeds the sales summary
 * on Orders.tsx (ventas del mes, ingresos por método de pago), which needs
 * every payment across whatever set of orders the current filters leave
 * visible, not just one order at a time like listPaymentsForOrder. */
export async function listPaymentsForTenant(tenantId: string): Promise<SalesOrderPayment[]> {
  const { data, error } = await supabase.from('sales_order_payments').select('*').eq('tenant_id', tenantId).is('deleted_at', null)
  if (error) throw error
  return data
}

export async function createPayment(input: OrderPaymentInput): Promise<SalesOrderPayment> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('sales_order_payments')
    .insert({ ...input, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Soft delete -- a payment logged by mistake is removed and re-created,
 * never edited in place (see plan for the reasoning). */
export async function deletePayment(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('sales_order_payments').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

/** Generates a real Wompi checkout link for this order's exact remaining
 * balance (computed server-side, never here) -- the human-agent
 * counterpart to the AI's generate_payment_link tool, same underlying
 * createSalesOrderPaymentLink helper. The link isn't recorded as a payment
 * yet: that only happens once the customer actually pays and
 * payment-webhook-wompi records it, same as the AI path. Same error-message
 * extraction pattern as createCheckoutForInvoice in billing.ts. */
export async function createWompiPaymentLink(orderId: string): Promise<{ checkoutUrl: string; amount: number; orderCode: string }> {
  const { data, error } = await supabase.functions.invoke<{ checkout_url: string; amount: number; order_code: string; error?: string }>(
    'create-sales-order-payment-link',
    { body: { order_id: orderId } },
  )
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const body = await context.json()
        specificMessage = body?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  if (!data || data.error) throw new Error(data?.error ?? 'No se pudo generar el link de pago.')
  return { checkoutUrl: data.checkout_url, amount: data.amount, orderCode: data.order_code }
}
