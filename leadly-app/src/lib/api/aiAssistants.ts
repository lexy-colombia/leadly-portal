import { supabase } from '../supabaseClient'
import type { AiAssistant, AiProvider } from '../../types/domain'

export interface AiAssistantInput {
  name: string
  provider: AiProvider
  model: string
  system_prompt: string
  temperature: number
  max_tokens: number
  is_active: boolean
}

export async function listAiAssistantsByTenant(tenantId: string): Promise<AiAssistant[]> {
  const { data, error } = await supabase.from('ai_assistants').select('*').eq('tenant_id', tenantId).order('created_at')
  if (error) throw error
  return data
}

export async function getAiAssistant(id: string): Promise<AiAssistant | null> {
  const { data, error } = await supabase.from('ai_assistants').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function createAiAssistant(tenantId: string, input: AiAssistantInput): Promise<AiAssistant> {
  const { data, error } = await supabase
    .from('ai_assistants')
    .insert({ tenant_id: tenantId, ...input })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateAiAssistant(id: string, input: AiAssistantInput, updatedBy: string): Promise<AiAssistant> {
  const { data, error } = await supabase
    .from('ai_assistants')
    .update({ ...input, updated_by: updatedBy })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

/** Blocked server-side (FK `on delete restrict`) while any whatsapp_lines
 * row still points at this agent -- surfaces that as a clear message instead
 * of a raw Postgres foreign-key-violation string. */
export async function deleteAiAssistant(id: string): Promise<void> {
  const { error } = await supabase.from('ai_assistants').delete().eq('id', id)
  if (error) {
    if (error.code === '23503') throw new Error('Este agente está asignado a una o más líneas de WhatsApp. Reasígnalas antes de eliminarlo.')
    throw error
  }
}

/** Assigns (or unassigns, with `assistantId: null`) the agent that answers
 * for a given WhatsApp line -- the same agent can be assigned to several
 * lines at once. */
export async function assignAiAssistantToLine(lineId: string, assistantId: string | null): Promise<void> {
  const { error } = await supabase.from('whatsapp_lines').update({ ai_assistant_id: assistantId }).eq('id', lineId)
  if (error) throw error
}
