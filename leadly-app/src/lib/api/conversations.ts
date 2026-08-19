import { supabase } from '../supabaseClient'
import type { ConversationCategory, ConversationMode, ConversationStatus, WhatsappConversation, WhatsappMessage } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

// Shared between ChatPanel (category select) and ConversationListItem (category
// pill) so the two never drift out of sync on which key maps to which category.
export const CONVERSATION_CATEGORY_KEY: Record<ConversationCategory, TranslationKey> = {
  venta: 'inbox.category.venta',
  soporte: 'inbox.category.soporte',
  consulta: 'inbox.category.consulta',
  reclamo: 'inbox.category.reclamo',
  otro: 'inbox.category.otro',
}

// `contact_name` on the conversation itself is whatever WhatsApp reports as
// the contact's own profile name, and whatsapp-webhook keeps refreshing it on
// every inbound message -- it's never editable from the CRM. `contact` (the
// linked crm_contacts row) is what the tenant actually edits in "Clientes",
// so every UI that displays a conversation's contact name must prefer
// `contact.full_name` over `contact_name`, never the other way around.
export type ConversationWithLine = WhatsappConversation & {
  whatsapp_line: { display_name: string; business_account_id: string } | null
  contact: { full_name: string } | null
  agent: { full_name: string } | null
}

export function conversationDisplayName(conversation: ConversationWithLine): string {
  return conversation.contact?.full_name || conversation.contact_name || conversation.contact_phone
}

export async function listConversations(tenantId: string): Promise<ConversationWithLine[]> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*, whatsapp_line:whatsapp_lines(display_name, business_account_id), contact:clients(full_name), agent:profiles!assigned_agent_id(full_name)')
    .eq('tenant_id', tenantId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (error) throw error
  return data as unknown as ConversationWithLine[]
}

/** "Último contacto" per CRM contact, used by the Clientes list -- derived
 * from the most recent WhatsApp message across all of a contact's linked
 * conversations rather than a stored column, since it's cheap to compute
 * from data that already exists (whatsapp_conversations is indexed on
 * contact_id) and never needs its own migration/trigger to stay in sync. */
export async function listLastContactTimesByTenant(tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('contact_id, last_message_at')
    .eq('tenant_id', tenantId)
    .not('contact_id', 'is', null)
    .not('last_message_at', 'is', null)
  if (error) throw error

  const result = new Map<string, string>()
  for (const row of data as { contact_id: string; last_message_at: string }[]) {
    const current = result.get(row.contact_id)
    if (!current || row.last_message_at > current) result.set(row.contact_id, row.last_message_at)
  }
  return result
}

/** Links (or re-links) a conversation to a client -- used from the Inbox
 * when a conversation came in unlinked (see whatsapp-webhook: it stopped
 * auto-creating a client per inbound number, since not every sender is
 * actually a client) and an agent decides the sender is worth tracking as
 * one, whether by picking an existing client or creating a new one first
 * (see LinkClientDrawer). Doesn't touch `contact_phone`/`contact_name` --
 * those stay whatever WhatsApp reported, independent of the linked client's
 * own editable name. */
export async function linkConversationContact(conversationId: string, contactId: string): Promise<void> {
  const { error } = await supabase.from('whatsapp_conversations').update({ contact_id: contactId }).eq('id', conversationId)
  if (error) throw error
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

export interface MessageTiming {
  conversation_id: string
  direction: WhatsappMessage['direction']
  created_at: string
}

/** Bulk, lightweight message fetch (3 columns, no content) across many
 * conversations at once -- used by the Dashboard to compute a real "tiempo
 * promedio de respuesta" (average gap between an inbound message and the
 * next outbound one in the same conversation) instead of fabricating it.
 * Empty array short-circuits instead of running `.in('conversation_id', [])`. */
export async function listMessageTimingsForConversations(conversationIds: string[]): Promise<MessageTiming[]> {
  if (conversationIds.length === 0) return []
  const { data, error } = await supabase
    .from('whatsapp_messages')
    .select('conversation_id, direction, created_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function setConversationMode(conversationId: string, mode: ConversationMode): Promise<void> {
  // Devolver a modo ia resetea el contador de no leídos -- la IA se hace
  // cargo de lo que siga llegando, no queda nada "pendiente de leer" para un
  // agente (ver bump_conversation_unread_count, que ya no acumula en modo ia).
  const update = mode === 'ia' ? { mode, unread_count: 0 } : { mode }
  const { error } = await supabase.from('whatsapp_conversations').update(update).eq('id', conversationId)
  if (error) throw error
}

/** Marca una conversación como leída (badge de no leídos, ver
 * bump_conversation_unread_count) -- se llama al abrirla en el Inbox y de
 * nuevo por cada mensaje entrante que llegue mientras sigue abierta, para
 * que el contador no vuelva a subir bajo la vista del agente que la está
 * mirando en ese momento. */
export async function markConversationRead(conversationId: string): Promise<void> {
  const { error } = await supabase.from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', conversationId)
  if (error) throw error
}

export async function setConversationCategory(conversationId: string, category: ConversationCategory | null): Promise<void> {
  const { error } = await supabase.from('whatsapp_conversations').update({ category }).eq('id', conversationId)
  if (error) throw error
}

/** Archiving is purely about Inbox visibility -- a separate axis from
 * `status` (who's currently responding) -- so it never touches mode/status/
 * context, unlike closing a conversation. */
export async function setConversationArchived(conversationId: string, archived: boolean): Promise<void> {
  const { error } = await supabase
    .from('whatsapp_conversations')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', conversationId)
  if (error) throw error
}

export async function listConversationsForContact(contactId: string): Promise<ConversationWithLine[]> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*, whatsapp_line:whatsapp_lines(display_name, business_account_id), contact:clients(full_name), agent:profiles!assigned_agent_id(full_name)')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (error) throw error
  return data as unknown as ConversationWithLine[]
}

/** Same as listConversationsForContact but for every contact linked to an
 * account -- "Conversaciones" tab on the Empresa detail screen. Empty array
 * short-circuits (an account with no contacts yet) instead of running a
 * `.in('contact_id', [])` query, which Postgres would happily run but always
 * return nothing for anyway. */
export async function listConversationsForContacts(contactIds: string[]): Promise<ConversationWithLine[]> {
  if (contactIds.length === 0) return []
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('*, whatsapp_line:whatsapp_lines(display_name, business_account_id), contact:clients(full_name), agent:profiles!assigned_agent_id(full_name)')
    .in('contact_id', contactIds)
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

/** WhatsApp's business-initiated-message window: Meta rejects free text
 * outside 24h since the contact's last inbound message, requiring an
 * approved template (HSM) instead -- see CLAUDE.md, Fase 1 de "iniciar
 * conversaciones". */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

/** Whether free text can still be sent to this (line, phone) pair, or a
 * template is required -- a brand-new contact (no `existing` row) always
 * needs a template, same as a contact who last wrote more than 24h ago. */
export async function getConversationWindowStatus(
  whatsappLineId: string,
  contactPhone: string,
): Promise<{ conversationId: string | null; windowOpen: boolean }> {
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('id, last_inbound_message_at')
    .eq('whatsapp_line_id', whatsappLineId)
    .eq('contact_phone', contactPhone)
    .maybeSingle()
  if (error) throw error
  if (!data) return { conversationId: null, windowOpen: false }
  const windowOpen = !!data.last_inbound_message_at && Date.now() - new Date(data.last_inbound_message_at).getTime() < WHATSAPP_WINDOW_MS
  return { conversationId: data.id, windowOpen }
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

export async function sendHumanMessage(
  conversationId: string,
  content: string,
  media?: { storage_path: string; mime_type: string; size_bytes: number },
): Promise<WhatsappMessage> {
  const { data, error } = await supabase.functions.invoke('whatsapp-send-human', {
    body: { conversation_id: conversationId, content, media },
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

/** Manually re-triggers the AI for a conversation that got stuck with no
 * reply -- see whatsapp-retry-ai-response. Same purpose as the automatic
 * retry now built into whatsapp-webhook, but for cases that need a human to
 * notice and act (the automatic retries were also exhausted, or the
 * assistant was inactive at the time and got turned back on since). */
export async function retryAiResponse(conversationId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('whatsapp-retry-ai-response', {
    body: { conversation_id: conversationId },
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
}
