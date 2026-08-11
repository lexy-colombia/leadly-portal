import { supabase } from '../supabaseClient'
import type { CrmOrderComment } from '../../types/domain'

export type OrderCommentWithAuthor = CrmOrderComment & { author: { full_name: string } | null }

export async function listCommentsForOrder(orderId: string): Promise<OrderCommentWithAuthor[]> {
  const { data, error } = await supabase
    .from('crm_order_comments')
    .select('*, author:profiles!author_id(full_name)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as OrderCommentWithAuthor[]
}

export async function createComment(tenantId: string, orderId: string, content: string): Promise<CrmOrderComment> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('crm_order_comments')
    .insert({ tenant_id: tenantId, order_id: orderId, content, author_id: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}
