import { supabase } from '../supabaseClient'
import type { Dispatch, DispatchCarrierType, DispatchStatusHistoryEntry } from '../../types/domain'

export async function getDispatchForOrder(salesOrderId: string): Promise<Dispatch | null> {
  const { data, error } = await supabase.from('dispatches').select('*').eq('sales_order_id', salesOrderId).maybeSingle()
  if (error) throw error
  return data
}

export interface DispatchStatusSummary {
  name: string
  color: string
}

/** Lightweight lookup for OrderDetail.tsx's inline "Estado de envío" --
 * the order shows the dispatch's real, tenant-named status directly (ej.
 * "Despachado"), not the legacy 3-value delivery_status bucket (feedback
 * del usuario: mapear a mano entre los dos era confuso). Falls back to
 * null when there's no dispatch yet, same as getDispatchForOrder. */
export async function getDispatchStatusForOrder(salesOrderId: string): Promise<DispatchStatusSummary | null> {
  const { data, error } = await supabase
    .from('dispatches')
    .select('status:dispatch_statuses(name, color)')
    .eq('sales_order_id', salesOrderId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as { status: DispatchStatusSummary | null } | null)?.status ?? null
}

export interface DispatchCreateInput {
  tenant_id: string
  sales_order_id: string
  status_id: string
  warehouse_id: string
  carrier_type: DispatchCarrierType
  carrier_key?: string | null
  carrier_name?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  notes?: string | null
}

export async function createDispatch(input: DispatchCreateInput): Promise<Dispatch> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('dispatches')
    .insert({ ...input, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}

export interface DispatchUpdateInput {
  status_id?: string
  carrier_type?: DispatchCarrierType
  carrier_key?: string | null
  carrier_name?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  notes?: string | null
}

export async function updateDispatch(id: string, input: DispatchUpdateInput): Promise<Dispatch> {
  const { data, error } = await supabase.from('dispatches').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function listDispatchHistory(dispatchId: string): Promise<DispatchStatusHistoryEntry[]> {
  const { data, error } = await supabase.from('dispatch_status_history').select('*').eq('dispatch_id', dispatchId).order('created_at')
  if (error) throw error
  return data
}
