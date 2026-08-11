import { supabase } from '../supabaseClient'
import type { WhatsappLine, WhatsappLineStatus } from '../../types/domain'

export interface WhatsappLineInput {
  tenant_id: string
  display_name: string
  phone_number_id: string
  business_account_id: string
}

export type WhatsappLineWithTenant = WhatsappLine & { tenant: { name: string } | null }

export async function listWhatsappLines(): Promise<WhatsappLineWithTenant[]> {
  const { data, error } = await supabase
    .from('whatsapp_lines')
    .select('*, tenant:tenants(name)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as WhatsappLineWithTenant[]
}

export async function listWhatsappLinesByTenant(tenantId: string): Promise<WhatsappLine[]> {
  const { data, error } = await supabase
    .from('whatsapp_lines')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getWhatsappLine(id: string): Promise<WhatsappLineWithTenant | null> {
  const { data, error } = await supabase.from('whatsapp_lines').select('*, tenant:tenants(name)').eq('id', id).maybeSingle()
  if (error) throw error
  return data as unknown as WhatsappLineWithTenant | null
}

/** Creates the line and a default (inactive) AI agent for it in the same
 * step -- a line should never exist without something to edit on the
 * "IA & Agentes" screen. Agents are no longer owned 1:1 by a line (an agent
 * can be reassigned to other lines, or shared across several), so this just
 * seeds a private starting point and links it back via the line's own
 * `ai_assistant_id` -- the tenant can swap it for a shared agent later.
 * Rolls back the line if the assistant insert fails, mirroring Bedly's
 * admin-create-user rollback-on-partial-failure pattern. */
export async function createWhatsappLine(input: WhatsappLineInput): Promise<WhatsappLine> {
  const { data: line, error: lineError } = await supabase.from('whatsapp_lines').insert(input).select().single()
  if (lineError) throw lineError

  const { data: defaultModel, error: modelError } = await supabase
    .from('ai_models')
    .select('provider, model_code')
    .eq('provider', 'openai')
    .eq('is_active', true)
    .order('display_order', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (modelError || !defaultModel) {
    await supabase.from('whatsapp_lines').delete().eq('id', line.id)
    throw modelError ?? new Error('No hay un modelo de IA activo por defecto configurado.')
  }

  const { data: assistant, error: assistantError } = await supabase
    .from('ai_assistants')
    .insert({
      tenant_id: input.tenant_id,
      name: `Asistente de ${input.display_name}`,
      provider: defaultModel.provider,
      model: defaultModel.model_code,
      system_prompt: '',
      is_active: false,
    })
    .select('id')
    .single()

  if (assistantError) {
    await supabase.from('whatsapp_lines').delete().eq('id', line.id)
    throw assistantError
  }

  const { error: linkError } = await supabase.from('whatsapp_lines').update({ ai_assistant_id: assistant.id }).eq('id', line.id)
  if (linkError) throw linkError

  return { ...line, ai_assistant_id: assistant.id }
}

export async function updateWhatsappLine(id: string, input: WhatsappLineInput): Promise<WhatsappLine> {
  const { data, error } = await supabase.from('whatsapp_lines').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function setWhatsappLineStatus(id: string, status: WhatsappLineStatus): Promise<WhatsappLine> {
  const { data, error } = await supabase.from('whatsapp_lines').update({ status }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Disconnects a line: hard-deletes it (row + Vault-stored access token) if
 * it has no conversations yet, or -- if it does -- keeps the row and its
 * conversation history but flips it to status 'disconnected' and drops the
 * access token, so it can never send/receive again. See delete_whatsapp_line
 * RPC (20260809180000_whatsapp_line_disconnect_keeps_history.sql). */
export async function deleteWhatsappLine(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_whatsapp_line', { p_line_id: id })
  if (error) throw new Error(error.message)
}

export async function setWhatsappLineAccessToken(id: string, accessToken: string): Promise<void> {
  const { error } = await supabase.rpc('set_whatsapp_line_access_token', { p_line_id: id, p_access_token: accessToken })
  if (error) throw error
}

export async function whatsappLineHasAccessToken(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('whatsapp_line_has_access_token', { p_line_id: id })
  if (error) throw error
  return !!data
}

/** Finishes WhatsApp Embedded Signup server-side (code exchange needs the
 * Meta App Secret, which never reaches the browser) -- see
 * lib/metaEmbeddedSignup.ts for the client-side popup step that produces
 * these values. */
export async function connectWhatsappLineViaEmbeddedSignup(
  code: string,
  wabaId: string,
  phoneNumberId: string,
  displayName: string,
): Promise<WhatsappLine> {
  const { data, error } = await supabase.functions.invoke('whatsapp-embedded-signup', {
    body: { code, waba_id: wabaId, phone_number_id: phoneNumberId, display_name: displayName },
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
  return data.line
}
