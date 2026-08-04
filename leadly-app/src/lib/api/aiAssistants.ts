import { supabase } from '../supabaseClient'
import type { AiAssistant, AiProvider } from '../../types/domain'

export interface AiAssistantInput {
  provider: AiProvider
  model: string
  system_prompt: string
  temperature: number
  max_tokens: number
  is_active: boolean
}

export async function getAiAssistantByLine(whatsappLineId: string): Promise<AiAssistant | null> {
  const { data, error } = await supabase.from('ai_assistants').select('*').eq('whatsapp_line_id', whatsappLineId).maybeSingle()
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
