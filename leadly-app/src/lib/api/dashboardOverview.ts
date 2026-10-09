import { supabase } from '../supabaseClient'
import { collectById } from '../analytics/pagination'
import type { OrderWithRelations } from './orders'
import type { Client } from '../../types/domain'
type CreditClient = Pick<Client, 'id' | 'full_name'>

export type OverviewOrder = Pick<
  OrderWithRelations,
  | 'id'
  | 'number'
  | 'created_at'
  | 'total'
  | 'status'
  | 'delivery_status'
  | 'sales_channel'
> & { contact: { full_name: string } | null }
/** Period history plus ALL current pending orders, including old ones. Lean, keyset-paginated. */
export async function listOverviewOrders(
  tenantId: string,
  from: string,
): Promise<OverviewOrder[]> {
  return collectById(async (after) => {
    let query = supabase
      .from('sales_orders')
      .select(
        'id,number,created_at,total,status,delivery_status,sales_channel,contact:clients(full_name)',
      )
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .or(
        `created_at.gte.${from},and(status.eq.confirmada,delivery_status.neq.entregado)`,
      )
      .order('id')
      .limit(500)
    if (after) query = query.gt('id', after)
    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as unknown as OverviewOrder[]
  })
}
export async function listOverviewDispatches(tenantId: string, from: string) {
  return collectById(async (after) => {
    let query = supabase
      .from('dispatches')
      .select('id,created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', from)
      .order('id')
      .limit(500)
    if (after) query = query.gt('id', after)
    const { data, error } = await query
    if (error) throw error
    return data ?? []
  })
}
export async function listOverviewConversations(
  tenantId: string,
  start: string,
  end: string,
) {
  return collectById(async (after) => {
    let query = supabase
      .from('whatsapp_conversations')
      .select('id,last_message_at')
      .eq('tenant_id', tenantId)
      .gte('last_message_at', start)
      .lt('last_message_at', end)
      .order('id')
      .limit(500)
    if (after) query = query.gt('id', after)
    const { data, error } = await query
    if (error) throw error
    return data ?? []
  })
}
/** Includes a 24h lookback to pair responses at the start of the selected period. */
export async function listOverviewMessageTimings(
  tenantId: string,
  ids: string[],
  start: Date,
  end: Date,
) {
  type Timing = {
    id: string
    conversation_id: string
    direction: 'inbound' | 'outbound'
    created_at: string
  }
  const result: Timing[] = []
  const lookback = new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString()
  for (let offset = 0; offset < ids.length; offset += 50) {
    const rows = await collectById<Timing>(async (after) => {
      let query = supabase
        .from('whatsapp_messages')
        .select(
          'id,conversation_id,direction,created_at,conversation:whatsapp_conversations!inner(tenant_id)',
        )
        .eq('conversation.tenant_id', tenantId)
        .in('conversation_id', ids.slice(offset, offset + 50))
        .gte('created_at', lookback)
        .lt('created_at', end.toISOString())
        .order('id')
        .limit(500)
      if (after) query = query.gt('id', after)
      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as Timing[]
    })
    result.push(...rows)
  }
  return result.sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )
}
/** Keep the live receivable balance complete beyond the Data API row cap. */
export async function getOverviewCredit(tenantId: string) {
  async function clients() {
    return collectById<CreditClient>(async (after) => {
      let query = supabase
        .from('clients')
        .select('id,full_name')
        .eq('tenant_id', tenantId)
        .eq('credit_enabled', true)
        .is('deleted_at', null)
        .order('id')
        .limit(500)
      if (after) query = query.gt('id', after)
      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as CreditClient[]
    })
  }
  async function ledger(table: 'credit_charges' | 'credit_payments') {
    return collectById(async (after) => {
      let query = supabase
        .from(table)
        .select('id,client_id,amount')
        .eq('tenant_id', tenantId)
        .order('id')
        .limit(500)
      if (table === 'credit_payments') query = query.is('deleted_at', null)
      if (after) query = query.gt('id', after)
      const { data, error } = await query
      if (error) throw error
      return data ?? []
    })
  }
  const [customers, charges, payments] = await Promise.all([
    clients(),
    ledger('credit_charges'),
    ledger('credit_payments'),
  ])
  const charged = new Map<string, number>(),
    paid = new Map<string, number>()
  charges.forEach((row) =>
    charged.set(row.client_id, (charged.get(row.client_id) ?? 0) + row.amount),
  )
  payments.forEach((row) =>
    paid.set(row.client_id, (paid.get(row.client_id) ?? 0) + row.amount),
  )
  return customers.map((client) => ({
    client,
    totalCharged: charged.get(client.id) ?? 0,
    totalPaid: paid.get(client.id) ?? 0,
    balance: (charged.get(client.id) ?? 0) - (paid.get(client.id) ?? 0),
  }))
}
