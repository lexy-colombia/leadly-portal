import { supabase } from '../supabaseClient'
import type { ConversationCategory, ConversationMode, ConversationStatus, WhatsappConversation, WhatsappMessage } from '../../types/domain'

// `contact_name` on the conversation itself is whatever WhatsApp reports as
// the contact's own profile name, and whatsapp-webhook keeps refreshing it on
// every inbound message -- it's never editable from the CRM. `contact` (the
// linked crm_contacts row) is what the tenant actually edits in "Clientes",
// so every UI that displays a conversation's contact name must prefer
// `contact.full_name` over `contact_name`, never the other way around.
export type ConversationWithLine = WhatsappConversation & {
  whatsapp_line: { display_name: string } | null
  contact: { full_name: string } | null
  agent: { full_name: string } | null
}

export function conversationDisplayName(conversation: ConversationWithLine): string {
  return conversation.contact?.full_name || conversation.contact_name || conversation.contact_phone
}

export async function listConversations(tenantId: string): Promise<ConversationWithLine[]> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*, whatsapp_line:whatsapp_lines(display_name), contact:crm_contacts(full_name), agent:profiles!assigned_agent_id(full_name)')
    .eq('tenant_id', tenantId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (error) throw error
  return data as unknown as ConversationWithLine[]
}

export async function setConversationAssignee(conversationId: string, agentId: string | null): Promise<void> {
  const { error } = await supabase.from('whatsapp_conversations').update({ assigned_agent_id: agentId }).eq('id', conversationId)
  if (error) throw error
}

/** Closing just marks status='closed', nothing else changes -- the chat
 * history stays exactly as it is. Reopening (whether the tenant does it
 * manually to write to the contact again, or whatsapp-webhook does it
 * automatically when the contact writes in) also resets the AI's context
 * boundary and hands the conversation back to the AI by default, so it
 * feels like a genuinely fresh conversation instead of resuming a closed
 * one mid-thread. */
export async function setConversationStatus(conversationId: string, status: ConversationStatus): Promise<void> {
  const update: { status: ConversationStatus; context_reset_at?: string; mode?: ConversationMode } =
    status === 'open' ? { status, context_reset_at: new Date().toISOString(), mode: 'ia' } : { status }
  const { error } = await supabase.from('whatsapp_conversations').update(update).eq('id', conversationId)
  if (error) throw error
}

export async function listMessages(conversationId: string): Promise<WhatsappMessage[]> {
  const { data, error } = await supabase
    .from('whatsapp_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function setConversationMode(conversationId: string, mode: ConversationMode): Promise<void> {
  const { error } = await supabase.from('whatsapp_conversations').update({ mode }).eq('id', conversationId)
  if (error) throw error
}

export async function setConversationCategory(conversationId: string, category: ConversationCategory | null): Promise<void> {
  const { error } = await supabase.from('whatsapp_conversations').update({ category }).eq('id', conversationId)
  if (error) throw error
}

export async function listConversationsForContact(contactId: string): Promise<ConversationWithLine[]> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*, whatsapp_line:whatsapp_lines(display_name), contact:crm_contacts(full_name), agent:profiles!assigned_agent_id(full_name)')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (error) throw error
  return data as unknown as ConversationWithLine[]
}

/** Starts a conversation manually from the CRM side ("Nueva conversación" in
 * the Inbox) instead of waiting for an inbound WhatsApp message. Reuses the
 * existing row as-is if this contact+line pair already has one (never resets
 * an existing conversation's mode back to humano just because someone opened
 * "nueva conversación" on it again). Defaults new conversations to modo
 * humano: an agent starting a chat themselves almost always wants to type the
 * first message right away, not hand it to the AI. */
export async function createConversation(
  tenantId: string,
  whatsappLineId: string,
  contactId: string,
  contactPhone: string,
  contactName: string,
): Promise<WhatsappConversation> {
  const { data: existing, error: existingError } = await supabase
    .from('whatsapp_conversations')
    .select('*')
    .eq('whatsapp_line_id', whatsappLineId)
    .eq('contact_phone', contactPhone)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing) return existing

  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .insert({
      tenant_id: tenantId,
      whatsapp_line_id: whatsappLineId,
      contact_id: contactId,
      contact_phone: contactPhone,
      contact_name: contactName,
      mode: 'humano',
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/** Subscribes to new/updated rows for a single conversation's messages.
 * Returns an unsubscribe function -- callers must clean up on unmount, same
 * pattern as any other side-effecting subscription in this app. */
export function subscribeToMessages(conversationId: string, onInsert: (message: WhatsappMessage) => void): () => void {
  const channel = supabase
    .channel(`whatsapp_messages:${conversationId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'whatsapp_messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onInsert(payload.new as WhatsappMessage),
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}

/** Subscribes to conversation-list-level changes (new conversations, mode/last_message_at
 * updates) for a whole tenant, so the Inbox list can refresh without polling. */
export function subscribeToConversations(tenantId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`whatsapp_conversations:${tenantId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'whatsapp_conversations', filter: `tenant_id=eq.${tenantId}` },
      onChange,
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}

export async function sendHumanMessage(conversationId: string, content: string): Promise<WhatsappMessage> {
  const { data, error } = await supabase.functions.invoke('whatsapp-send-human', {
    body: { conversation_id: conversationId, content },
  })
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
  if (data?.error) throw new Error(data.error)
  return data.message
}
