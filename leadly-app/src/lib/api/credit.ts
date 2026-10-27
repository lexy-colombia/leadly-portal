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
  client: Pick<Client, 'id' | 'full_name'>
  totalCharged: number
  totalPaid: number
  balance: number
}

export interface CreditPortfolioTotals {
  clients: number
  withBalance: number
  totalCharged: number
  totalPaid: number
  totalBalance: number
}

interface CreditClientsRpcRow {
  client: { id: string; full_name: string }
  total_charged: number
  total_paid: number
  balance: number
}

/** Cartera: clientes con credit_enabled y su saldo, UNA página por llamada.
 * El saldo (cargos - pagos no borrados) y los totales de toda la cartera los
 * calcula el servidor (RPC list_credit_clients, migración 20261029150000):
 * antes se sumaban aquí las filas de los dos libros y PostgREST las cortaba
 * en 1000 sin error. */
export async function listCreditClientsPage(
  page: number,
  pageSize: number,
): Promise<{ rows: ClientCreditSummary[]; total: number; totals: CreditPortfolioTotals }> {
  const { data, error } = await supabase.rpc('list_credit_clients', { p_page: page, p_page_size: pageSize })
  if (error) throw error
  const res = data as {
    rows: CreditClientsRpcRow[]
    total: number
    summary: { clients: number; with_balance: number; total_charged: number; total_paid: number; total_balance: number }
  }
  return {
    rows: res.rows.map((r) => ({ client: r.client, totalCharged: r.total_charged, totalPaid: r.total_paid, balance: r.balance })),
    total: res.total,
    totals: {
      clients: res.summary.clients,
      withBalance: res.summary.with_balance,
      totalCharged: res.summary.total_charged,
      totalPaid: res.summary.total_paid,
      totalBalance: res.summary.total_balance,
    },
  }
}

/** Saldo de crédito de un cliente, calculado por el servidor
 * (RPC get_client_credit_summary). Cliente no visible -> lanza (nunca ceros
 * inventados). */
export async function getClientCreditSummary(client: Pick<Client, 'id'>): Promise<{ totalCharged: number; totalPaid: number; balance: number }> {
  const { data, error } = await supabase.rpc('get_client_credit_summary', { p_client_id: client.id })
  if (error) throw error
  if (!data) throw new Error('Client not found')
  const s = data as { total_charged: number; total_paid: number; balance: number }
  return { totalCharged: s.total_charged, totalPaid: s.total_paid, balance: s.balance }
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
