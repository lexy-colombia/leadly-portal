import { supabase } from '../supabaseClient'
import type { ConversationTag } from '../../types/domain'

export async function listConversationTags(tenantId: string): Promise<ConversationTag[]> {
  const { data, error } = await supabase
    .from('conversation_tags')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
  if (error) throw error
  return data
}

export async function createConversationTag(tenantId: string, name: string): Promise<ConversationTag> {
  const { data, error } = await supabase.from('conversation_tags').insert({ tenant_id: tenantId, name }).select().single()
  if (error) throw error
  return data
}

/** Soft delete (see CLAUDE.md section 3) -- stamps deleted_at/deleted_by
 * instead of removing the row, so conversations that already carry this tag
 * keep the historical link. `listConversationTags` filters `deleted_at is
 * null`, so it just disappears from the catalog and the assignment popover. */
export async function deleteConversationTag(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('conversation_tags')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}

/** Tag assignments for a batch of conversations at once (the Inbox already
 * has the full list of conversation ids after loading, so it just passes
 * those) -- fetches every row in one query and reduces to a map client-side,
 * same shape as `listLastContactTimesByTenant` in conversations.ts. RLS on
 * conversation_tag_assignments already scopes rows to the caller's own
 * tenant, so there's no need to filter by tenant_id here too. */
export async function listTagAssignmentsForConversations(conversationIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (conversationIds.length === 0) return result

  const { data, error } = await supabase.from('conversation_tag_assignments').select('conversation_id, tag_id').in('conversation_id', conversationIds)
  if (error) throw error

  for (const row of data as { conversation_id: string; tag_id: string }[]) {
    const existing = result.get(row.conversation_id)
    if (existing) existing.push(row.tag_id)
    else result.set(row.conversation_id, [row.tag_id])
  }
  return result
}

export async function listTagIdsForConversation(conversationId: string): Promise<string[]> {
  const { data, error } = await supabase.from('conversation_tag_assignments').select('tag_id').eq('conversation_id', conversationId)
  if (error) throw error
  return (data as { tag_id: string }[]).map((row) => row.tag_id)
}

/** Replaces the full set of tags on a conversation -- simplest correct
 * approach for a small checkbox picker (no diffing needed): clear then
 * re-insert whatever's currently checked. */
export async function setConversationTags(conversationId: string, tagIds: string[]): Promise<void> {
  const { error: deleteError } = await supabase.from('conversation_tag_assignments').delete().eq('conversation_id', conversationId)
  if (deleteError) throw deleteError

  if (tagIds.length === 0) return
  const { error: insertError } = await supabase
    .from('conversation_tag_assignments')
    .insert(tagIds.map((tagId) => ({ conversation_id: conversationId, tag_id: tagId })))
  if (insertError) throw insertError
}
