import { supabase } from '../supabaseClient'
import type { AiModel } from '../../types/domain'

export async function listAiModels(): Promise<AiModel[]> {
  const { data, error } = await supabase
    .from('ai_models')
    .select('*')
    .eq('is_active', true)
    .order('provider', { ascending: true })
    .order('display_order', { ascending: true })
  if (error) throw error
  return data
}
