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
/** Receivable balance per credit client, from the same server rule as the
 * Cartera screen (RPC list_credit_clients: charges of cancelled/deleted orders
 * do not count). The tenant is resolved server-side from the session, so the
 * argument is only kept for the caller's query key. */
export async function getOverviewCredit(_tenantId: string) {
  const pageSize = 100
  const rows: Array<{ client: CreditClient; totalCharged: number; totalPaid: number; balance: number }> = []
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.rpc('list_credit_clients', { p_page: page, p_page_size: pageSize })
    if (error) throw error
    const res = data as {
      rows: Array<{ client: CreditClient; total_charged: number; total_paid: number; balance: number }>
      total: number
    }
    res.rows.forEach((r) =>
      rows.push({ client: r.client, totalCharged: r.total_charged, totalPaid: r.total_paid, balance: r.balance }),
    )
    if (res.rows.length === 0 || page * pageSize >= res.total) break
  }
  return rows
}
