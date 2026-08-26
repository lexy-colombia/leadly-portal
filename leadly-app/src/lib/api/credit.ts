import { supabase } from '../supabaseClient'
import type { Client, CreditCharge, CreditPayment, CreditPaymentMethod } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

// Same set as orderPayments.ts's PAYMENT_METHOD_LABEL_KEY minus 'credito' --
// paying down a credit balance with more credit doesn't make sense.
export const CREDIT_PAYMENT_METHOD_LABEL_KEY: Record<CreditPaymentMethod, TranslationKey> = {
  efectivo: 'orders.paymentMethod.cash',
  transferencia: 'orders.paymentMethod.transfer',
  tarjeta: 'orders.paymentMethod.card',
}

export interface ClientCreditSummary {
  client: Client
  totalCharged: number
  totalPaid: number
  balance: number
}

/** Cartera list: every client with credit_enabled, plus their balance --
 * aggregated client-side from the two ledgers (same criterion as
 * computePipelineMetrics in lib/api/opportunities.ts) instead of a SQL
 * view, to avoid any ambiguity around RLS-on-views. */
export async function listCreditClients(tenantId: string): Promise<ClientCreditSummary[]> {
  const [{ data: clients, error: clientsError }, { data: charges, error: chargesError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from('clients').select('*').eq('tenant_id', tenantId).eq('credit_enabled', true).is('deleted_at', null).order('full_name'),
    supabase.from('credit_charges').select('client_id, amount').eq('tenant_id', tenantId),
    supabase.from('credit_payments').select('client_id, amount').eq('tenant_id', tenantId).is('deleted_at', null),
  ])
  if (clientsError) throw clientsError
  if (chargesError) throw chargesError
  if (paymentsError) throw paymentsError

  const chargedByClient = new Map<string, number>()
  for (const c of charges ?? []) chargedByClient.set(c.client_id, (chargedByClient.get(c.client_id) ?? 0) + c.amount)
  const paidByClient = new Map<string, number>()
  for (const p of payments ?? []) paidByClient.set(p.client_id, (paidByClient.get(p.client_id) ?? 0) + p.amount)

  return (clients ?? []).map((client) => {
    const totalCharged = chargedByClient.get(client.id) ?? 0
    const totalPaid = paidByClient.get(client.id) ?? 0
    return { client, totalCharged, totalPaid, balance: totalCharged - totalPaid }
  })
}

export async function getClientCreditSummary(client: Client): Promise<{ totalCharged: number; totalPaid: number; balance: number }> {
  const [{ data: charges, error: chargesError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from('credit_charges').select('amount').eq('client_id', client.id),
    supabase.from('credit_payments').select('amount').eq('client_id', client.id).is('deleted_at', null),
  ])
  if (chargesError) throw chargesError
  if (paymentsError) throw paymentsError
  const totalCharged = (charges ?? []).reduce((sum, c) => sum + c.amount, 0)
  const totalPaid = (payments ?? []).reduce((sum, p) => sum + p.amount, 0)
  return { totalCharged, totalPaid, balance: totalCharged - totalPaid }
}

export async function listCreditCharges(clientId: string): Promise<CreditCharge[]> {
  const { data, error } = await supabase.from('credit_charges').select('*').eq('client_id', clientId).order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function listCreditPayments(clientId: string): Promise<CreditPayment[]> {
  const { data, error } = await supabase
    .from('credit_payments')
    .select('*')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('paid_at', { ascending: false })
  if (error) throw error
  return data
}

export interface CreditPaymentInput {
  tenant_id: string
  client_id: string
  method: CreditPaymentMethod
  amount: number
  currency?: string
  paid_at?: string
  notes?: string | null
}

/** Registers an abono (payment against the client's overall credit
 * balance -- never against one specific order). The receipt_number comes
 * back auto-assigned by trg_credit_payments_set_receipt_number. */
export async function createCreditPayment(input: CreditPaymentInput): Promise<CreditPayment> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('credit_payments')
    .insert({ ...input, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Soft delete -- an abono logged by mistake is removed and re-created,
 * same criterion as sales_order_payments (see orderPayments.ts). Unlike
 * sales_order_payments this has no order to "close", so it stays
 * correctable. */
export async function deleteCreditPayment(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('credit_payments').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}
