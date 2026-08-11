import { supabase } from '../supabaseClient'
import type { CrmOrderPayment, OrderPaymentMethod } from '../../types/domain'

export interface OrderPaymentInput {
  tenant_id: string
  order_id: string
  method: OrderPaymentMethod
  amount: number
  currency?: string
  paid_at?: string
  notes?: string | null
}

export async function listPaymentsForOrder(orderId: string): Promise<CrmOrderPayment[]> {
  const { data, error } = await supabase
    .from('crm_order_payments')
    .select('*')
    .eq('order_id', orderId)
    .is('deleted_at', null)
    .order('paid_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createPayment(input: OrderPaymentInput): Promise<CrmOrderPayment> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('crm_order_payments')
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
  const { error } = await supabase.from('crm_order_payments').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
