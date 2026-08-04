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

/** Creates the line and a default (inactive) AI assistant config for it in
 * the same step -- ai_assistants is 1:1 with whatsapp_lines, so a line should
 * never exist without a config row to edit on the "Asistente de IA" screen.
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

  const { error: assistantError } = await supabase.from('ai_assistants').insert({
    whatsapp_line_id: line.id,
    provider: defaultModel.provider,
    model: defaultModel.model_code,
    system_prompt: '',
    is_active: false,
  })

  if (assistantError) {
    await supabase.from('whatsapp_lines').delete().eq('id', line.id)
    throw assistantError
  }

  return line
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

export async function setWhatsappLineAccessToken(id: string, accessToken: string): Promise<void> {
  const { error } = await supabase.rpc('set_whatsapp_line_access_token', { p_line_id: id, p_access_token: accessToken })
  if (error) throw error
}

export async function whatsappLineHasAccessToken(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('whatsapp_line_has_access_token', { p_line_id: id })
  if (error) throw error
  return !!data
}
